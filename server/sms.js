import { ObjectId } from 'mongodb';

const SMS_REQUEST_TIMEOUT = Number(process.env.SAMAYA_SMS_TIMEOUT || 15000);
const SMS_MAX_ATTEMPTS = Number(process.env.SAMAYA_SMS_MAX_ATTEMPTS || 3);
const SMS_DLR_MAX_ATTEMPTS = Number(process.env.SAMAYA_SMS_DLR_MAX_ATTEMPTS || 10);

const SMS_PROVIDERS = {
  samaya: {
    id: 'samaya',
    name: 'SamayaSMS',
    apiUrl: process.env.SAMAYA_SMS_API_URL || 'https://samayasms.com.np/smsapi/index.php',
    apiKey: process.env.SAMAYA_SMS_API_KEY || '',
    campaignId: process.env.SAMAYA_SMS_CAMPAIGN_ID || '',
    routeId: process.env.SAMAYA_SMS_ROUTE_ID || '10255',
    senderId: process.env.SAMAYA_SMS_SENDER_ID || 'Bit_Alert',
    baseUrl: process.env.SAMAYA_SMS_BASE_URL || 'https://samayasms.com.np',
    driver: 'smspasal',
    supportsDlr: true,
    supportedTypes: ['text', 'unicode', 'flash', 'wap', 'vcard']
  },
  smsPasal: {
    id: 'smsPasal',
    name: 'SMS Pasal',
    apiUrl: process.env.SMS_PASAL_API_URL || 'https://sms.smspasal.com/smsapi/index.php',
    apiKey: process.env.SMS_PASAL_API_KEY || '',
    campaignId: process.env.SMS_PASAL_CAMPAIGN_ID || '9835',
    routeId: process.env.SMS_PASAL_ROUTE_ID || '10305',
    senderId: process.env.SMS_PASAL_SENDER_ID || 'TN_ALERT',
    baseUrl: process.env.SMS_PASAL_BASE_URL || 'https://sms.smspasal.com',
    driver: 'smspasal',
    supportsDlr: true,
    supportedTypes: ['text', 'unicode', 'flash', 'wap', 'vcard']
  },
  bedbyas: {
    id: 'bedbyas',
    name: 'BedByAS Pokhrel',
    apiUrl: process.env.BEDBYAS_SMS_API_URL || 'https://bulksms.bedbyaspokhrel.com.np/sms/v4/send-user',
    apiKey: process.env.BEDBYAS_SMS_API_TOKEN || '',
    campaignId: '',
    routeId: '',
    senderId: process.env.BEDBYAS_SMS_SENDER_LABEL || 'API v4',
    baseUrl: process.env.BEDBYAS_SMS_BASE_URL || 'https://bulksms.bedbyaspokhrel.com.np',
    driver: 'bedbyasV4',
    supportsDlr: false,
    supportedTypes: ['text', 'unicode']
  }
};

let workerRunning = false;
let workerTimer = null;
const providerSummaryCache = new Map();

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    configured: Boolean(provider.apiKey),
    senderId: provider.senderId,
    routeId: provider.routeId,
    campaignId: provider.campaignId,
    supportsDlr: provider.supportsDlr,
    supportedTypes: provider.supportedTypes
  };
}

function getProvider(providerId = 'samaya') {
  return SMS_PROVIDERS[providerId] || null;
}

function configuredProviders() {
  return Object.values(SMS_PROVIDERS).filter((provider) => provider.apiKey);
}

function providerError(message, retryable = true) {
  const error = new Error(String(message || 'SMS provider rejected the request.').slice(0, 240));
  error.retryable = retryable;
  return error;
}

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

async function fetchText(url, options = {}, timeoutMs = SMS_REQUEST_TIMEOUT, providerName = 'SMS provider') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${providerName} returned HTTP ${response.status}: ${text.slice(0, 180)}`);
    return text;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${providerName} request timed out.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function baseSmsParams(provider, type, phone) {
  const params = new URLSearchParams({
    key: provider.apiKey,
    type,
    contacts: phone,
    senderid: provider.senderId,
    responsetype: 'json'
  });
  if (provider.campaignId) params.set('campaign', provider.campaignId);
  if (provider.routeId) params.set('routeid', provider.routeId);
  return params;
}

async function submitSms(delivery) {
  const provider = getProvider(delivery.providerId);
  if (!provider?.apiKey) throw new Error(`SMS provider ${delivery.providerId || 'unknown'} is not configured in Railway.`);
  if (provider.driver === 'bedbyasV4') {
    const raw = await fetchText(provider.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-token': provider.apiKey },
      body: JSON.stringify({ to: [delivery.phone], text: [delivery.message] })
    }, SMS_REQUEST_TIMEOUT, provider.name);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${provider.name} returned an invalid JSON response.`); }
    const responseItem = Array.isArray(parsed.responses) ? parsed.responses[0] : parsed;
    if (parsed.error || responseItem?.error || (Array.isArray(parsed.errors) && parsed.errors.length)) {
      throw new Error(String(responseItem?.message || parsed.message || parsed.errors?.[0] || 'SMS submission failed.').slice(0, 240));
    }
    const valid = responseItem?.data?.valid?.[0];
    if (!valid?.id) throw new Error(`Unexpected ${provider.name} response: ${raw.slice(0, 240)}`);
    return { shootId: String(valid.id), providerResponse: parsed, supportsDlr: false };
  }
  const params = baseSmsParams(provider, delivery.type, delivery.phone);
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

  const raw = await fetchText(provider.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  }, SMS_REQUEST_TIMEOUT, provider.name);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const resultText = typeof parsed === 'string' ? parsed : raw;
  const parsedText = parsed ? JSON.stringify(parsed) : resultText;
  if (Number(parsed?.response_code) >= 400) {
    throw providerError(`${provider.name}: ${parsed.message || `request rejected (${parsed.response_code})`}`, false);
  }
  const shootMatch = resultText.match(/SMS-SHOOT-ID\/([a-zA-Z0-9_-]+)/i)
    || parsedText.match(/SMS-SHOOT-ID[\\/\":\s]+([a-zA-Z0-9_-]+)/i)
    || String(parsed?.shoot_id || parsed?.shootId || parsed?.data?.shoot_id || '').match(/([a-zA-Z0-9_-]+)/);
  if (/^\s*ERR:/i.test(resultText) || parsed?.error) {
    throw new Error(String(parsed?.error || resultText).slice(0, 240));
  }
  if (!shootMatch) throw new Error(`Unexpected ${provider.name} response: ${resultText.slice(0, 240)}`);
  return { shootId: shootMatch[1], providerResponse: parsed || raw, supportsDlr: provider.supportsDlr };
}

async function updateCampaignAfterDelivery(db, campaignId, status, errorMessage = '') {
  const increment = { processed: 1 };
  increment[status === 'submitted' ? 'submitted' : 'failed'] = 1;
  const patch = { updatedAt: new Date() };
  if (errorMessage) patch.lastError = errorMessage;
  const campaign = await campaignsCollection(db).findOneAndUpdate(
    { id: campaignId },
    { $inc: increment, $set: patch },
    { returnDocument: 'after' }
  );
  if (campaign && campaign.processed >= campaign.total) {
    await campaignsCollection(db).updateOne(
      { id: campaignId },
      { $set: { status: campaign.failed === campaign.total ? 'Failed' : 'Tracking', pendingDlr: campaign.submitted || 0, submittedAt: new Date(), updatedAt: new Date() } }
    );
  }
}

async function includeCampaignErrors(db, campaigns) {
  const missingErrorIds = campaigns
    .filter((campaign) => Number(campaign.failed || 0) > 0 && !campaign.lastError)
    .map((campaign) => campaign.id);
  if (!missingErrorIds.length) return campaigns.map(withoutMongoId);

  const latestErrors = await deliveriesCollection(db).aggregate([
    { $match: { campaignId: { $in: missingErrorIds }, error: { $exists: true, $nin: ['', null] } } },
    { $sort: { updatedAt: -1 } },
    { $group: { _id: '$campaignId', lastError: { $first: '$error' } } }
  ]).toArray();
  const errorsByCampaign = new Map(latestErrors.map((item) => [item._id, item.lastError]));

  return campaigns.map((campaign) => withoutMongoId({
    ...campaign,
    lastError: campaign.lastError || errorsByCampaign.get(campaign.id) || ''
  }));
}

async function refreshCampaignTracking(db, campaignId) {
  const counts = await deliveriesCollection(db).aggregate([
    { $match: { campaignId } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  const byStatus = Object.fromEntries(counts.map((item) => [item._id, item.count]));
  const delivered = byStatus.delivered || 0;
  const deliveryFailed = byStatus.delivery_failed || 0;
  const pendingDlr = (byStatus.submitted || 0) + (byStatus.dlr_checking || 0);
  const dlrUnavailable = byStatus.dlr_unavailable || 0;
  const patch = { delivered, deliveryFailed, pendingDlr, dlrUnavailable, updatedAt: new Date() };
  if (pendingDlr === 0) {
    patch.status = 'Completed';
    patch.completedAt = new Date();
  } else {
    patch.status = 'Tracking';
  }
  await campaignsCollection(db).updateOne({ id: campaignId }, { $set: patch });
  return patch;
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
    const status = result.supportsDlr === false ? 'dlr_unavailable' : 'submitted';
    await deliveriesCollection(db).updateOne(
      { id: delivery.id },
      { $set: { status, shootId: result.shootId, providerResponse: result.providerResponse, submittedAt: new Date(), nextDlrAt: result.supportsDlr === false ? null : new Date(Date.now() + 120000), dlrAttempts: 0, dlrError: result.supportsDlr === false ? 'Provider does not publish a DLR endpoint.' : '', lockedAt: null, updatedAt: new Date() } }
    );
    await updateCampaignAfterDelivery(db, delivery.campaignId, 'submitted');
    if (result.supportsDlr === false) await refreshCampaignTracking(db, delivery.campaignId);
  } catch (error) {
    const attempts = Number(delivery.attempts || 0) + 1;
    if (attempts < SMS_MAX_ATTEMPTS && error.retryable !== false) {
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: 'queued', attempts, error: error.message, nextAttemptAt: new Date(Date.now() + attempts * 30000), lockedAt: null, updatedAt: new Date() } }
      );
    } else {
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: 'failed', attempts, error: error.message, failedAt: new Date(), lockedAt: null, updatedAt: new Date() } }
      );
      await updateCampaignAfterDelivery(db, delivery.campaignId, 'failed', error.message);
    }
  }
  return true;
}

function dlrRetryDelay(attempts) {
  const delays = [2, 5, 10, 20, 30, 60, 120, 240, 480, 720];
  return (delays[Math.min(attempts, delays.length - 1)] || 720) * 60000;
}

async function fetchDeliveryReport(providerId, shootId, phone) {
  const provider = getProvider(providerId);
  if (!provider?.apiKey) throw new Error(`SMS provider ${providerId || 'unknown'} is not configured.`);
  const raw = await fetchText(`${provider.baseUrl}/miscapi/${encodeURIComponent(provider.apiKey)}/getDLR/${encodeURIComponent(shootId)}`, {}, SMS_REQUEST_TIMEOUT, provider.name);
  if (/^\s*ERR:/i.test(raw)) throw new Error(raw.trim());
  const reports = JSON.parse(raw);
  const report = Array.isArray(reports) ? reports.find((item) => cleanPhone(item.MSISDN) === phone) || reports[0] : null;
  if (!report) return { terminal: false, report: null };
  const statusText = `${report.DLR || ''} ${report.DESC || ''}`;
  if (/delivered/i.test(report.DLR || '')) return { terminal: true, delivered: true, report };
  if (/failed|reject|expired|undeliver|invalid|blocked/i.test(statusText)) return { terminal: true, delivered: false, report };
  return { terminal: false, report };
}

async function processNextDlr(getDb) {
  const db = await getDb();
  const now = new Date();
  const delivery = await deliveriesCollection(db).findOneAndUpdate(
    {
      status: 'submitted',
      shootId: { $exists: true, $ne: '' },
      $and: [
        { $or: [{ nextDlrAt: { $lte: now } }, { nextDlrAt: { $exists: false } }] },
        { $or: [{ dlrAttempts: { $lt: SMS_DLR_MAX_ATTEMPTS } }, { dlrAttempts: { $exists: false } }] },
        { $or: [{ dlrLockedAt: null }, { dlrLockedAt: { $exists: false } }, { dlrLockedAt: { $lt: new Date(Date.now() - 120000) } }] }
      ]
    },
    { $set: { status: 'dlr_checking', dlrLockedAt: now, updatedAt: now } },
    { sort: { nextDlrAt: 1, submittedAt: 1 }, returnDocument: 'after' }
  );
  if (!delivery) return false;

  const attempts = Number(delivery.dlrAttempts || 0) + 1;
  try {
    const result = await fetchDeliveryReport(delivery.providerId || 'samaya', delivery.shootId, delivery.phone);
    if (result.terminal) {
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: result.delivered ? 'delivered' : 'delivery_failed', dlr: result.report, dlrAttempts: attempts, dlrCheckedAt: new Date(), dlrLockedAt: null, updatedAt: new Date() } }
      );
    } else {
      const exhausted = attempts >= SMS_DLR_MAX_ATTEMPTS;
      await deliveriesCollection(db).updateOne(
        { id: delivery.id },
        { $set: { status: exhausted ? 'dlr_unavailable' : 'submitted', dlr: result.report, dlrAttempts: attempts, nextDlrAt: new Date(Date.now() + dlrRetryDelay(attempts)), dlrCheckedAt: new Date(), dlrLockedAt: null, updatedAt: new Date() } }
      );
    }
  } catch (error) {
    const exhausted = attempts >= SMS_DLR_MAX_ATTEMPTS;
    await deliveriesCollection(db).updateOne(
      { id: delivery.id },
      { $set: { status: exhausted ? 'dlr_unavailable' : 'submitted', dlrAttempts: attempts, dlrError: error.message, nextDlrAt: new Date(Date.now() + dlrRetryDelay(attempts)), dlrCheckedAt: new Date(), dlrLockedAt: null, updatedAt: new Date() } }
    );
  }
  await refreshCampaignTracking(db, delivery.campaignId);
  return true;
}

function scheduleWorker(getDb, delayMs = 0) {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(() => workerTick(getDb), delayMs);
  workerTimer.unref();
}

async function workerTick(getDb) {
  if (workerRunning || !configuredProviders().length) return;
  workerRunning = true;
  let processed = 0;
  try {
    for (let index = 0; index < 8; index += 1) {
      if (!await processNextDelivery(getDb)) break;
      processed += 1;
    }
    for (let index = 0; index < 4; index += 1) {
      if (!await processNextDlr(getDb)) break;
      processed += 1;
    }
  } catch (error) {
    console.error('SMS worker error:', error.message);
  } finally {
    workerRunning = false;
    scheduleWorker(getDb, processed ? 750 : 60000);
  }
}

async function getProviderSummary(provider, force = false) {
  if (!provider.apiKey) return { ...publicProvider(provider), balance: null, lastTransaction: null, providerError: '' };
  const cached = providerSummaryCache.get(provider.id);
  if (!force && cached?.expiresAt > Date.now()) return cached;
  let balance = null;
  let lastTransaction = null;
  let providerError = '';
  const summaryRequests = provider.driver === 'bedbyasV4'
    ? [
        fetchText(`${provider.baseUrl}/sms/v4/available-credit`, { headers: { 'auth-token': provider.apiKey } }, SMS_REQUEST_TIMEOUT, provider.name),
        fetchText(`${provider.baseUrl}/sms/v4/credit`, { method: 'POST', headers: { 'auth-token': provider.apiKey } }, SMS_REQUEST_TIMEOUT, provider.name)
      ]
    : [
        fetchText(`${provider.baseUrl}/miscapi/${encodeURIComponent(provider.apiKey)}/getBalance/true/`, {}, SMS_REQUEST_TIMEOUT, provider.name),
        fetchText(`${provider.baseUrl}/lasttran/index.php?key=${encodeURIComponent(provider.apiKey)}`, {}, SMS_REQUEST_TIMEOUT, provider.name)
      ];
  const [balanceResult, transactionResult] = await Promise.allSettled(summaryRequests);
  if (balanceResult.status === 'fulfilled') {
    try {
      const parsedBalance = JSON.parse(balanceResult.value);
      balance = provider.driver === 'bedbyasV4'
        ? [{ ROUTE_ID: '', ROUTE: provider.name, BALANCE: parsedBalance.available_credit }]
        : parsedBalance;
    } catch { providerError = `${provider.name} returned an invalid balance response.`; }
  } else {
    providerError = balanceResult.reason.message;
  }
  if (transactionResult.status === 'fulfilled') {
    try { lastTransaction = JSON.parse(transactionResult.value); } catch { lastTransaction = null; }
  }
  const summary = { ...publicProvider(provider), expiresAt: Date.now() + 120000, balance, lastTransaction, providerError };
  providerSummaryCache.set(provider.id, summary);
  return summary;
}

async function getPortalData(db, forceProvider = false) {
  const [contactCount, campaignCount, recentCampaigns, contacts, campaigns, providers] = await Promise.all([
    contactsCollection(db).countDocuments(),
    campaignsCollection(db).countDocuments(),
    campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(8).toArray(),
    contactsCollection(db).find({}).sort({ updatedAt: -1 }).limit(5000).toArray(),
    campaignsCollection(db).find({}).sort({ createdAt: -1 }).limit(100).toArray(),
    Promise.all(Object.values(SMS_PROVIDERS).map((provider) => getProviderSummary(provider, forceProvider)))
  ]);
  const defaultProvider = providers.find((provider) => provider.configured) || providers[0];
  const [recentCampaignResults, campaignResults] = await Promise.all([
    includeCampaignErrors(db, recentCampaigns),
    includeCampaignErrors(db, campaigns)
  ]);
  return {
    overview: {
      configured: providers.some((provider) => provider.configured),
      providerId: defaultProvider?.id,
      senderId: defaultProvider?.senderId,
      routeId: defaultProvider?.routeId,
      contactCount,
      campaignCount,
      providers: providers.map(({ expiresAt, ...provider }) => provider),
      balance: defaultProvider?.balance || null,
      lastTransaction: defaultProvider?.lastTransaction || null,
      providerError: providers.map((provider) => provider.providerError).filter(Boolean).join(' '),
      recentCampaigns: recentCampaignResults
    },
    contacts: contacts.map(withoutMongoId),
    campaigns: campaignResults
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
      const providers = await Promise.all(Object.values(SMS_PROVIDERS).map((provider) => getProviderSummary(provider, request.query.refresh === '1')));
      const defaultProvider = providers.find((provider) => provider.configured) || providers[0];
      response.json({ configured: providers.some((provider) => provider.configured), providerId: defaultProvider?.id, senderId: defaultProvider?.senderId, routeId: defaultProvider?.routeId, providers: providers.map(({ expiresAt, ...provider }) => provider), contactCount, campaignCount, balance: defaultProvider?.balance || null, lastTransaction: defaultProvider?.lastTransaction || null, providerError: providers.map((provider) => provider.providerError).filter(Boolean).join(' '), recentCampaigns: await includeCampaignErrors(db, recentCampaigns) });
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
      response.json(await includeCampaignErrors(db, campaigns));
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
      response.json(await includeCampaignErrors(db, campaigns));
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
      const providerId = String(request.body?.providerId || 'samaya');
      const provider = getProvider(providerId);
      if (!provider) return response.status(400).json({ message: 'Unknown SMS provider.' });
      if (!provider.apiKey) return response.status(503).json({ message: `${provider.name} is not configured in Railway.` });
      const type = String(request.body?.type || 'text').toLowerCase();
      if (!['text', 'unicode', 'flash', 'wap', 'vcard'].includes(type)) return response.status(400).json({ message: 'Unsupported SMS type.' });
      if (!provider.supportedTypes.includes(type)) return response.status(400).json({ message: `${provider.name} supports only ${provider.supportedTypes.join(' and ')} messages.` });
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
        providerId: provider.id,
        providerName: provider.name,
        providerSupportsDlr: provider.supportsDlr,
        senderId: provider.senderId,
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
        deliveryFailed: 0,
        pendingDlr: 0,
        dlrUnavailable: 0,
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
          providerId: provider.id,
          providerName: provider.name,
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
      const db = await getDb();
      const deliveries = await deliveriesCollection(db).find({ campaignId: request.params.id, status: { $in: ['submitted', 'dlr_unavailable'] }, shootId: { $ne: '' } }).limit(1000).toArray();
      let delivered = 0;
      let failed = 0;
      for (const delivery of deliveries) {
        try {
          const result = await fetchDeliveryReport(delivery.providerId || 'samaya', delivery.shootId, delivery.phone);
          if (!result.terminal) continue;
          await deliveriesCollection(db).updateOne({ id: delivery.id }, { $set: { status: result.delivered ? 'delivered' : 'delivery_failed', dlr: result.report, dlrCheckedAt: new Date(), dlrLockedAt: null, updatedAt: new Date() } });
          if (result.delivered) delivered += 1;
          if (!result.delivered) failed += 1;
        } catch {
          // A pending DLR is expected and can be refreshed later.
        }
      }
      await refreshCampaignTracking(db, request.params.id);
      response.json({ ok: true, delivered, failed });
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });
}
