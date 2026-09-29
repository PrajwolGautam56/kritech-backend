import { ObjectId } from 'mongodb';

const SMS_API_URL = process.env.SAMAYA_SMS_API_URL || 'https://samayasms.com.np/smsapi/index.php';
const SMS_API_KEY = process.env.SAMAYA_SMS_API_KEY || '';
const SMS_CAMPAIGN_ID = process.env.SAMAYA_SMS_CAMPAIGN_ID || '';
const SMS_ROUTE_ID = process.env.SAMAYA_SMS_ROUTE_ID || '10255';
const SMS_SENDER_ID = process.env.SAMAYA_SMS_SENDER_ID || 'Bit_Alert';
const SMS_REQUEST_TIMEOUT = Number(process.env.SAMAYA_SMS_TIMEOUT || 15000);
const SMS_MAX_ATTEMPTS = Number(process.env.SAMAYA_SMS_MAX_ATTEMPTS || 3);

let workerRunning = false;
let workerTimer = null;
let providerSummaryCache = { expiresAt: 0, balance: null, lastTransaction: null, providerError: '' };

function contactsCollection(db) {
  return db.collection('smsContacts');
}

function campaignsCollection(db) {
  return db.collection('smsCampaigns');
}

function deliveriesCollection(db) {
  return db.collection('smsDeliveries');
}

function withoutMongoId(item) {
  if (!item) return item;
  const { _id, ...rest } = item;
  return { ...rest, id: rest.id || _id?.toString() };
}

function cleanPhone(value = '') {
  let phone = String(value).replace(/[^0-9]/g, '');
  if (phone.startsWith('977') && phone.length === 13) phone = phone.slice(3);
  return phone;
}

function validNepalPhone(phone) {
  return /^9[678][0-9]{8}$/.test(phone);
}

function safeFieldName(value = '') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeContact(body = {}) {
  const reserved = new Set(['id', 'name', 'phone', 'group', 'tags', 'customFields', 'createdAt', 'updatedAt']);
  const customFields = body.customFields && typeof body.customFields === 'object' ? { ...body.customFields } : {};
  Object.entries(body).forEach(([key, value]) => {
    if (!reserved.has(key) && value !== undefined && value !== null && String(value).trim()) {
      customFields[safeFieldName(key)] = String(value).trim();
    }
  });
  return {
    id: body.id || new ObjectId().toString(),
    name: String(body.name || body.full_name || body.fullName || '').trim(),
    phone: cleanPhone(body.phone || body.mobile || body.contact || ''),
    group: String(body.group || body.list || 'General').trim() || 'General',
    tags: Array.isArray(body.tags)
      ? body.tags.map(String).map((item) => item.trim()).filter(Boolean)
      : String(body.tags || '').split(',').map((item) => item.trim()).filter(Boolean),
    customFields,
    updatedAt: new Date()
  };
}

function renderTemplate(template, contact) {
  const values = {
    name: contact.name || '',
    phone: contact.phone || '',
    group: contact.group || '',
    ...contact.customFields
  };
  return String(template || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => values[key] ?? '');
}

async function fetchText(url, options = {}, timeoutMs = SMS_REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`SamayaSMS returned HTTP ${response.status}: ${text.slice(0, 180)}`);
    return text;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('SamayaSMS request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function baseSmsParams(type, phone) {
  const params = new URLSearchParams({
    key: SMS_API_KEY,
    type,
    contacts: phone,
    senderid: SMS_SENDER_ID,
    responsetype: 'json'
  });
  if (SMS_CAMPAIGN_ID) params.set('campaign', SMS_CAMPAIGN_ID);
  if (SMS_ROUTE_ID) params.set('routeid', SMS_ROUTE_ID);
  return params;
}

async function submitSms(delivery) {
  if (!SMS_API_KEY) throw new Error('SAMAYA_SMS_API_KEY is not configured in Railway.');
  const params = baseSmsParams(delivery.type, delivery.phone);
  if (delivery.type === 'wap') {
    params.set('wap_title', delivery.payload.wapTitle || 'Open link');
    params.set('wap_url', delivery.payload.wapUrl);
  } else if (delivery.type === 'vcard') {
    Object.entries({
      first_name: delivery.payload.firstName,
      last_name: delivery.payload.lastName,
      company: delivery.payload.company,
      job_title: delivery.payload.jobTitle,
      telephone: delivery.payload.telephone,
      email: delivery.payload.email
    }).forEach(([key, value]) => value && params.set(key, value));
  } else {
    params.set('msg', delivery.message);
  }

  const raw = await fetchText(SMS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const resultText = typeof parsed === 'string' ? parsed : raw;
  const parsedText = parsed ? JSON.stringify(parsed) : resultText;
  const shootMatch = resultText.match(/SMS-SHOOT-ID\/([a-zA-Z0-9_-]+)/i)
    || parsedText.match(/SMS-SHOOT-ID[\\/\":\s]+([a-zA-Z0-9_-]+)/i)
    || String(parsed?.shoot_id || parsed?.shootId || parsed?.data?.shoot_id || '').match(/([a-zA-Z0-9_-]+)/);
  if (/^\s*ERR:/i.test(resultText) || parsed?.error) {
    throw new Error(String(parsed?.error || resultText).slice(0, 240));
  }
  if (!shootMatch) throw new Error(`Unexpected SamayaSMS response: ${resultText.slice(0, 240)}`);
  return { shootId: shootMatch[1], providerResponse: parsed || raw };
}

async function updateCampaignAfterDelivery(db, campaignId, status) {
  const increment = { processed: 1 };
  increment[status === 'submitted' ? 'submitted' : 'failed'] = 1;
  const campaign = await campaignsCollection(db).findOneAndUpdate(
    { id: campaignId },
    { $inc: increment, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (campaign && campaign.processed >= campaign.total) {
    await campaignsCollection(db).updateOne(
      { id: campaignId },
      { $set: { status: campaign.failed === campaign.total ? 'Failed' : 'Completed', completedAt: new Date(), updatedAt: new Date() } }
    );
  }
}

async function processNextDelivery(getDb) {
  const db = await getDb();
  const now = new Date();
  const delivery = await deliveriesCollection(db).findOneAndUpdate(
    {
      status: 'queued',
      nextAttemptAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(Date.now() - 120000) } }]
    },
    { $set: { status: 'processing', lockedAt: now, updatedAt: now } },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }
  );
  if (!delivery) return false;

  try {
    const result = await submitSms(delivery);
    await deliveriesCollection(db).updateOne(
      { id: delivery.id },
      { $set: { status: 'submitted', shootId: result.shootId, providerResponse: result.providerResponse, submittedAt: new Date(), lockedAt: null, updatedAt: new Date() } }
    );
    await updateCampaignAfterDelivery(db, delivery.campaignId, 'submitted');
  } catch (error) {
    const attempts = Number(delivery.attempts || 0) + 1;
    if (attempts < SMS_MAX_ATTEMPTS) {
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: 'queued', attempts, error: error.message, nextAttemptAt: new Date(Date.now() + attempts * 30000), lockedAt: null, updatedAt: new Date() } }
      );
    } else {
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: 'failed', attempts, error: error.message, failedAt: new Date(), lockedAt: null, updatedAt: new Date() } }
      );
      await updateCampaignAfterDelivery(db, delivery.campaignId, 'failed');
    }
  }
  return true;
}

function scheduleWorker(getDb, delayMs = 0) {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(() => workerTick(getDb), delayMs);
  workerTimer.unref();
}

async function workerTick(getDb) {
  if (workerRunning || !SMS_API_KEY) return;
  workerRunning = true;
  let processed = 0;
  try {
    for (let index = 0; index < 8; index += 1) {
      if (!await processNextDelivery(getDb)) break;
      processed += 1;
    }
  } catch (error) {
    console.error('SMS worker error:', error.message);
  } finally {
    workerRunning = false;
    scheduleWorker(getDb, processed ? 750 : 60000);
  }
}

async function getProviderSummary(force = false) {
  if (!SMS_API_KEY) return { balance: null, lastTransaction: null, providerError: '' };
  if (!force && providerSummaryCache.expiresAt > Date.now()) return providerSummaryCache;
  let balance = null;
  let lastTransaction = null;
  let providerError = '';
  try {
    const [balanceRaw, transactionRaw] = await Promise.all([
      fetchText(`https://samayasms.com.np/miscapi/${encodeURIComponent(SMS_API_KEY)}/getBalance/true/`),
      fetchText(`https://samayasms.com.np/lasttran/index.php?key=${encodeURIComponent(SMS_API_KEY)}`)
    ]);
    balance = JSON.parse(balanceRaw);
    lastTransaction = JSON.parse(transactionRaw);
  } catch (error) {
    providerError = error.message;
  }
  providerSummaryCache = { expiresAt: Date.now() + 120000, balance, lastTransaction, providerError };
  return providerSummaryCache;
}

async function getPortalData(db, forceProvider = false) {
  const [contactCount, campaignCount, recentCampaigns, contacts, campaigns, provider] = await Promise.all([
    contactsCollection(db).countDocuments(),
    campaignsCollection(db).countDocuments(),
    campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(8).toArray(),
    contactsCollection(db).find({}).sort({ updatedAt: -1 }).limit(5000).toArray(),
    campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(100).toArray(),
    getProviderSummary(forceProvider)
  ]);
  return {
    overview: {
      configured: Boolean(SMS_API_KEY && SMS_SENDER_ID),
      senderId: SMS_SENDER_ID,
      routeId: SMS_ROUTE_ID,
      contactCount,
      campaignCount,
      balance: provider.balance,
      lastTransaction: provider.lastTransaction,
      providerError: provider.providerError,
      recentCampaigns: recentCampaigns.map(withoutMongoId)
    },
    contacts: contacts.map(withoutMongoId),
    campaigns: campaigns.map(withoutMongoId)
  };
}

export function startSmsWorker(getDb) {
  getDb().then((db) => Promise.all([
    contactsCollection(db).createIndex({ phone: 1 }, { unique: true }),
    campaignsCollection(db).createIndex({ createdAt: -1 }),
    deliveriesCollection(db).createIndex({ status: 1, nextAttemptAt: 1, lockedAt: 1 }),
    deliveriesCollection(db).createIndex({ campaignId: 1, createdAt: -1 })
  ])).catch((error) => console.error('SMS index setup error:', error.message));
  scheduleWorker(getDb, 1500);
}

export function registerSmsRoutes(app, { getDb, requireAdmin, requirePermission }) {
  const protect = [requireAdmin, requirePermission('sms')];

  app.get('/api/sms/overview', ...protect, async (request, response) => {
    try {
      const db = await getDb();
      const [contactCount, campaignCount, recentCampaigns] = await Promise.all([
        contactsCollection(db).countDocuments(),
        campaignsCollection(db).countDocuments(),
        campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(8).toArray()
      ]);
      const { balance, lastTransaction, providerError } = await getProviderSummary(request.query.refresh === '1');
      response.json({ configured: Boolean(SMS_API_KEY && SMS_SENDER_ID), senderId: SMS_SENDER_ID, routeId: SMS_ROUTE_ID, contactCount, campaignCount, balance, lastTransaction, providerError, recentCampaigns: recentCampaigns.map(withoutMongoId) });
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/sms/bootstrap', ...protect, async (request, response) => {
    try {
      const db = await getDb();
      response.json(await getPortalData(db, request.query.refresh === '1'));
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/sms/campaign-status', ...protect, async (_request, response) => {
    try {
      const db = await getDb();
      const campaigns = await campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(100).toArray();
      response.json(campaigns.map(withoutMongoId));
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/sms/contacts', ...protect, async (request, response) => {
    try {
      const db = await getDb();
      const query = {};
      if (request.query.group) query.group = request.query.group;
      if (request.query.search) {
        const search = String(request.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search } }];
      }
      const contacts = await contactsCollection(db).find(query).sort({ updatedAt: -1 }).limit(5000).toArray();
      response.json(contacts.map(withoutMongoId));
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.post('/api/sms/contacts/import', ...protect, async (request, response) => {
    try {
      const rows = Array.isArray(request.body?.contacts) ? request.body.contacts.slice(0, 5000) : [];
      if (!rows.length) return response.status(400).json({ message: 'Add at least one contact.' });
      const normalized = rows.map(normalizeContact).filter((item) => validNepalPhone(item.phone));
      if (!normalized.length) return response.status(400).json({ message: 'No valid Nepal mobile numbers found. Use 10-digit numbers such as 98XXXXXXXX.' });
      const db = await getDb();
      await contactsCollection(db).bulkWrite(normalized.map((contact) => ({
        updateOne: {
          filter: { phone: contact.phone },
          update: { $set: contact, $setOnInsert: { createdAt: new Date() } },
          upsert: true
        }
      })));
      response.status(201).json({ imported: normalized.length, skipped: rows.length - normalized.length });
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/sms/contacts/:id', ...protect, async (request, response) => {
    try {
      const db = await getDb();
      await contactsCollection(db).deleteOne({ id: request.params.id });
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/sms/campaigns', ...protect, async (_request, response) => {
    try {
      const db = await getDb();
      const campaigns = await campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(100).toArray();
      response.json(campaigns.map(withoutMongoId));
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/sms/campaigns/:id/deliveries', ...protect, async (request, response) => {
    try {
      const db = await getDb();
      const deliveries = await deliveriesCollection(db).find({ campaignId: request.params.id }).sort({ createdAt: -1 }).limit(2000).toArray();
      response.json(deliveries.map(withoutMongoId));
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.post('/api/sms/campaigns', ...protect, async (request, response) => {
    try {
      if (!SMS_API_KEY) return response.status(503).json({ message: 'SMS API is not configured in Railway.' });
      const type = String(request.body?.type || 'text').toLowerCase();
      if (!['text', 'unicode', 'flash', 'wap', 'vcard'].includes(type)) return response.status(400).json({ message: 'Unsupported SMS type.' });
      const contactIds = Array.isArray(request.body?.contactIds) ? request.body.contactIds : [];
      const group = String(request.body?.group || '').trim();
      const template = String(request.body?.template || '').trim();
      const payload = request.body?.payload && typeof request.body.payload === 'object' ? request.body.payload : {};
      if (!contactIds.length && !group) return response.status(400).json({ message: 'Select contacts or a contact group.' });
      if (!['wap', 'vcard'].includes(type) && !template) return response.status(400).json({ message: 'Message template is required.' });
      if (type === 'wap' && !payload.wapUrl) return response.status(400).json({ message: 'WAP URL is required.' });
      if (type === 'vcard' && !payload.firstName) return response.status(400).json({ message: 'vCard first name is required.' });

      const db = await getDb();
      const contactQuery = contactIds.length ? { id: { $in: contactIds } } : { group };
      const contacts = await contactsCollection(db).find(contactQuery).limit(5000).toArray();
      if (!contacts.length) return response.status(400).json({ message: 'No contacts matched this campaign.' });
      const scheduleDate = request.body?.scheduledAt ? new Date(request.body.scheduledAt) : new Date();
      if (Number.isNaN(scheduleDate.getTime())) return response.status(400).json({ message: 'Scheduled date is invalid.' });
      const now = new Date();
      const campaign = {
        id: new ObjectId().toString(),
        name: String(request.body?.name || `${type.toUpperCase()} campaign`).trim(),
        type,
        template,
        payload,
        group: group || '',
        status: scheduleDate > now ? 'Scheduled' : 'Processing',
        total: contacts.length,
        processed: 0,
        submitted: 0,
        delivered: 0,
        failed: 0,
        scheduledAt: scheduleDate,
        createdBy: request.admin.email,
        createdAt: now,
        updatedAt: now
      };
      const deliveries = contacts.map((contact) => {
        const message = renderTemplate(template, contact);
        return {
          id: new ObjectId().toString(),
          campaignId: campaign.id,
          contactId: contact.id,
          name: contact.name,
          phone: contact.phone,
          group: contact.group,
          type: type === 'text' && /[^\x00-\x7F]/.test(message) ? 'unicode' : type,
          message,
          payload,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: scheduleDate,
          lockedAt: null,
          createdAt: now,
          updatedAt: now
        };
      });
      await campaignsCollection(db).insertOne(campaign);
      await deliveriesCollection(db).insertMany(deliveries);
      response.status(202).json(withoutMongoId(campaign));
      scheduleWorker(getDb, 25);
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.post('/api/sms/campaigns/:id/sync-dlr', ...protect, async (request, response) => {
    try {
      if (!SMS_API_KEY) return response.status(503).json({ message: 'SMS API is not configured.' });
      const db = await getDb();
      const deliveries = await deliveriesCollection(db).find({ campaignId: request.params.id, status: 'submitted', shootId: { $ne: '' } }).limit(1000).toArray();
      let delivered = 0;
      let failed = 0;
      for (const delivery of deliveries) {
        try {
          const raw = await fetchText(`https://samayasms.com.np/miscapi/${encodeURIComponent(SMS_API_KEY)}/getDLR/${encodeURIComponent(delivery.shootId)}`);
          const reports = JSON.parse(raw);
          const report = Array.isArray(reports) ? reports.find((item) => cleanPhone(item.MSISDN) === delivery.phone) || reports[0] : null;
          if (!report) continue;
          const isDelivered = /delivered/i.test(report.DLR || '');
          const isFailed = /failed|reject|expired|undeliver/i.test(`${report.DLR || ''} ${report.DESC || ''}`);
          if (!isDelivered && !isFailed) continue;
          await deliveriesCollection(db).updateOne({ id: delivery.id }, { $set: { status: isDelivered ? 'delivered' : 'delivery_failed', dlr: report, updatedAt: new Date() } });
          if (isDelivered) delivered += 1;
          if (isFailed) failed += 1;
        } catch {
          // A pending DLR is expected and can be refreshed later.
        }
      }
      const counts = await deliveriesCollection(db).aggregate([{ $match: { campaignId: request.params.id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
      const byStatus = Object.fromEntries(counts.map((item) => [item._id, item.count]));
      await campaignsCollection(db).updateOne({ id: request.params.id }, { $set: { delivered: byStatus.delivered || 0, deliveryFailed: byStatus.delivery_failed || 0, updatedAt: new Date() } });
      response.json({ ok: true, delivered, failed });
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });
}
