import 'dotenv/config';
import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';
import { getDb, pingDb } from './mongo.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const clientOrigins = (process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;
const cloudinaryUploadFolder = process.env.CLOUDINARY_UPLOAD_FOLDER || 'kritech/blog';
const adminEmail = process.env.ADMIN_EMAIL;
const adminPasswordSalt = process.env.ADMIN_PASSWORD_SALT;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const adminTokenSecret = process.env.ADMIN_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const frontendUrl = process.env.FRONTEND_URL || clientOrigins[0] || 'http://127.0.0.1:5173';
const mailFrom = process.env.MAIL_FROM || process.env.SMTP_USER || 'Kritech Solution <no-reply@kritechsolution.com>';
const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined,
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 15000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 10000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20000),
  tls: process.env.SMTP_HOST ? {
    servername: process.env.SMTP_HOST
  } : undefined
};
const accessModules = ['posts', 'inquiries', 'leads', 'seo', 'sitemap', 'users'];
const mailer = smtpConfig.host ? nodemailer.createTransport(smtpConfig) : null;

app.use(cors({
  origin(origin, callback) {
    if (!origin || clientOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '4mb' }));

function postsCollection(db) {
  return db.collection('posts');
}

function seoCollection(db) {
  return db.collection('seo');
}

function inquiriesCollection(db) {
  return db.collection('inquiries');
}

function leadsCollection(db) {
  return db.collection('leads');
}

function usersCollection(db) {
  return db.collection('users');
}

function authCollection(db) {
  return db.collection('auth');
}

function resetTokensCollection(db) {
  return db.collection('passwordResets');
}

function serializePost(post) {
  if (!post) return post;
  const { _id, ...rest } = post;
  return {
    ...rest,
    id: rest.id || _id?.toString()
  };
}

function serializeInquiry(inquiry) {
  if (!inquiry) return inquiry;
  const { _id, ...rest } = inquiry;
  return {
    ...rest,
    id: rest.id || _id?.toString()
  };
}

function serializeLead(lead) {
  if (!lead) return lead;
  const { _id, ...rest } = lead;
  return {
    ...rest,
    id: rest.id || _id?.toString()
  };
}

function serializeUser(user) {
  if (!user) return user;
  const { _id, passwordHash, passwordSalt, ...rest } = user;
  return {
    ...rest,
    id: rest.id || _id?.toString()
  };
}

function superAdminUser() {
  return {
    id: 'env-super-admin',
    name: 'Prajwol Gautam',
    email: adminEmail,
    role: 'Super Admin',
    status: 'Active',
    permissions: accessModules,
    systemUser: true
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex')
  };
}

async function sendMail({ to, subject, text, html }) {
  if (!mailer) {
    throw new Error('SMTP is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM in Railway variables.');
  }
  return mailer.sendMail({ from: mailFrom, to, subject, text, html });
}

function normalizePost(post) {
  const now = new Date().toISOString().slice(0, 10);
  return {
    id: post.id || new ObjectId().toString(),
    title: post.title || 'Untitled post',
    slug: post.slug || `untitled-${Date.now()}`,
    excerpt: post.excerpt || '',
    category: post.category || 'SEO',
    author: post.author || 'Kritech Team',
    date: post.date || now,
    status: post.status || 'Draft',
    metaTitle: post.metaTitle || post.title || 'Untitled post',
    metaDescription: post.metaDescription || post.excerpt || '',
    content: post.content || '',
    featuredImage: post.featuredImage || '',
    cloudinaryPublicId: post.cloudinaryPublicId || '',
    tags: Array.isArray(post.tags) ? post.tags : parseList(post.tags),
    focusKeyword: post.focusKeyword || '',
    canonicalUrl: post.canonicalUrl || '',
    seoTitle: post.seoTitle || post.metaTitle || post.title || 'Untitled post',
    seoDescription: post.seoDescription || post.metaDescription || post.excerpt || '',
    ogTitle: post.ogTitle || post.metaTitle || post.title || 'Untitled post',
    ogDescription: post.ogDescription || post.metaDescription || post.excerpt || '',
    noIndex: Boolean(post.noIndex),
    scheduledAt: post.scheduledAt || '',
    readingTime: post.readingTime || '',
    updatedAt: new Date()
  };
}

function normalizeLead(body = {}) {
  const now = new Date();
  return {
    id: new ObjectId().toString(),
    company: String(body.company || '').trim(),
    contactName: String(body.contactName || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    phone: String(body.phone || '').trim(),
    website: String(body.website || '').trim(),
    location: String(body.location || '').trim(),
    serviceInterest: String(body.serviceInterest || '').trim(),
    source: String(body.source || '').trim(),
    status: String(body.status || 'New').trim(),
    remarks: String(body.remarks || '').trim(),
    emailCount: 0,
    lastEmailAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeInquiry(body = {}, request) {
  const now = new Date();
  return {
    id: new ObjectId().toString(),
    name: String(body.name || '').trim(),
    contact: String(body.contact || '').trim(),
    service: String(body.service || '').trim(),
    location: String(body.location || '').trim(),
    message: String(body.message || '').trim(),
    sourcePage: String(body.sourcePage || '').trim(),
    status: 'New',
    note: '',
    userAgent: request.headers['user-agent'] || '',
    ip: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || '',
    createdAt: now,
    updatedAt: now
  };
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function signCloudinaryParams(params) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto.createHash('sha1').update(`${payload}${cloudinaryApiSecret}`).digest('hex');
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', adminTokenSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expected = crypto.createHmac('sha256', adminTokenSecret).update(`${header}.${body}`).digest('base64url');
    if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPassword(password) {
  if (!adminPasswordSalt || !adminPasswordHash || typeof password !== 'string') return false;
  return verifyPasswordHash(password, adminPasswordSalt, adminPasswordHash);
}

async function verifySuperAdminPassword(password) {
  try {
    const db = await getDb();
    const override = await authCollection(db).findOne({ key: 'superAdminPassword' });
    if (override?.passwordSalt && override?.passwordHash) {
      return verifyPasswordHash(password, override.passwordSalt, override.passwordHash);
    }
  } catch {
    return verifyPassword(password);
  }
  return verifyPassword(password);
}

function verifyPasswordHash(password, salt, expectedHash) {
  if (!salt || !expectedHash || typeof password !== 'string') return false;
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  if (Buffer.byteLength(hash) !== Buffer.byteLength(expectedHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

function requireAdmin(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const session = verifyToken(token);
  if (!session || !session.email) {
    response.status(401).json({ message: 'Admin login required.' });
    return;
  }
  request.admin = session;
  next();
}

function requireSuperAdmin(request, response, next) {
  if (request.admin?.role !== 'Super Admin') {
    response.status(403).json({ message: 'Super Admin access required.' });
    return;
  }
  next();
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (request.admin?.role === 'Super Admin' || request.admin?.permissions?.includes(permission)) {
      next();
      return;
    }
    response.status(403).json({ message: `You do not have ${permission} access.` });
  };
}

function requireAnyPermission(permissions) {
  return (request, response, next) => {
    if (
      request.admin?.role === 'Super Admin'
      || permissions.some((permission) => request.admin?.permissions?.includes(permission))
    ) {
      next();
      return;
    }
    response.status(403).json({ message: 'You do not have access to update this content.' });
  };
}

app.get('/api/health', async (_request, response) => {
  try {
    response.json(await pingDb());
  } catch (error) {
    response.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/login', (request, response) => {
  const { email, password } = request.body || {};
  if (!adminEmail || !adminPasswordHash || !adminPasswordSalt) {
    response.status(500).json({ message: 'Admin credentials are not configured.' });
    return;
  }

  const login = async () => {
    if (email === adminEmail && await verifySuperAdminPassword(password)) {
      return superAdminUser();
    }

    const db = await getDb();
    const user = await usersCollection(db).findOne({ email });
    if (!user || user.status !== 'Active' || !verifyPasswordHash(password, user.passwordSalt, user.passwordHash)) {
      return null;
    }
    return serializeUser(user);
  };

  login()
    .then((admin) => {
      if (!admin) {
        response.status(401).json({ message: 'Invalid email or password.' });
        return;
      }

      const expiresAt = Math.floor(Date.now() / 1000) + (60 * 60 * 12);
      response.json({
        token: signToken({
          id: admin.id,
          email: admin.email,
          role: admin.role,
          permissions: admin.permissions || [],
          exp: expiresAt
        }),
        admin,
        expiresAt
      });
    })
    .catch((error) => {
      response.status(500).json({ message: error.message });
    });
});

app.post('/api/auth/request-reset', async (request, response) => {
  try {
    const email = String(request.body?.email || '').trim().toLowerCase();
    if (!email) {
      response.status(400).json({ message: 'Email is required.' });
      return;
    }

    const db = await getDb();
    const isSuperAdmin = email === adminEmail;
    const user = isSuperAdmin ? superAdminUser() : await usersCollection(db).findOne({ email, status: 'Active' });

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await resetTokensCollection(db).insertOne({
        tokenHash,
        email,
        userId: user.id,
        isSuperAdmin,
        used: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 30),
        createdAt: new Date()
      });

      const resetUrl = `${frontendUrl.replace(/\/$/, '')}/admin-reset?token=${token}`;
      await sendMail({
        to: email,
        subject: 'Reset your Kritech CMS password',
        text: `Reset your Kritech CMS password using this link: ${resetUrl}\n\nThis link expires in 30 minutes.`,
        html: `<p>Reset your Kritech CMS password using this link:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 30 minutes.</p>`
      });
    }

    response.json({ ok: true, message: 'If the email exists, a reset link has been sent.' });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.post('/api/auth/reset-password', async (request, response) => {
  try {
    const token = String(request.body?.token || '').trim();
    const password = String(request.body?.password || '');
    if (!token || password.length < 8) {
      response.status(400).json({ message: 'Reset token and a password of at least 8 characters are required.' });
      return;
    }

    const db = await getDb();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = await resetTokensCollection(db).findOne({
      tokenHash,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!reset) {
      response.status(400).json({ message: 'Reset link is invalid or expired.' });
      return;
    }

    const { salt, hash } = hashPassword(password);
    if (reset.isSuperAdmin) {
      await authCollection(db).updateOne(
        { key: 'superAdminPassword' },
        { $set: { key: 'superAdminPassword', passwordSalt: salt, passwordHash: hash, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    } else {
      await usersCollection(db).updateOne(
        { email: reset.email },
        { $set: { passwordSalt: salt, passwordHash: hash, updatedAt: new Date() } }
      );
    }

    await resetTokensCollection(db).updateOne({ _id: reset._id }, { $set: { used: true, usedAt: new Date() } });
    response.json({ ok: true, message: 'Password reset successful. You can login now.' });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/auth/me', requireAdmin, (request, response) => {
  response.json({ admin: request.admin });
});

app.post('/api/cloudinary/signature', requireAdmin, requirePermission('posts'), (_request, response) => {
  if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    response.status(500).json({ message: 'Cloudinary environment variables are missing.' });
    return;
  }

  const timestamp = Math.round(Date.now() / 1000);
  const params = {
    folder: cloudinaryUploadFolder,
    timestamp
  };

  response.json({
    ...params,
    apiKey: cloudinaryApiKey,
    cloudName: cloudinaryCloudName,
    signature: signCloudinaryParams(params)
  });
});

app.get('/api/content', async (_request, response) => {
  try {
    const db = await getDb();
    const [posts, seoDoc] = await Promise.all([
      postsCollection(db).find({}).sort({ date: -1, updatedAt: -1 }).toArray(),
      seoCollection(db).findOne({ key: 'siteSeo' })
    ]);

    response.json({
      posts: posts.map(serializePost),
      seo: seoDoc?.items || {}
    });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.put('/api/content', requireAdmin, requireAnyPermission(['posts', 'seo']), async (request, response) => {
  try {
    const db = await getDb();
    const posts = Array.isArray(request.body.posts) ? request.body.posts.map(normalizePost) : [];
    const seo = request.body.seo && typeof request.body.seo === 'object' ? request.body.seo : {};

    if (posts.length) {
      await postsCollection(db).bulkWrite(
        posts.map((post) => ({
          updateOne: {
            filter: { id: post.id },
            update: { $set: post, $setOnInsert: { createdAt: new Date() } },
            upsert: true
          }
        }))
      );
    }

    await seoCollection(db).updateOne(
      { key: 'siteSeo' },
      { $set: { key: 'siteSeo', items: seo, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    response.json({ ok: true, postsSaved: posts.length });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.post('/api/inquiries', async (request, response) => {
  try {
    const inquiry = normalizeInquiry(request.body, request);

    if (!inquiry.name || !inquiry.contact || !inquiry.message) {
      response.status(400).json({ message: 'Please provide your name, phone/email and project message.' });
      return;
    }

    const db = await getDb();
    await inquiriesCollection(db).insertOne(inquiry);
    response.status(201).json({
      ok: true,
      inquiry: serializeInquiry(inquiry)
    });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/inquiries', requireAdmin, requirePermission('inquiries'), async (_request, response) => {
  try {
    const db = await getDb();
    const inquiries = await inquiriesCollection(db).find({}).sort({ createdAt: -1 }).toArray();
    response.json(inquiries.map(serializeInquiry));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.patch('/api/inquiries/:id', requireAdmin, requirePermission('inquiries'), async (request, response) => {
  try {
    const patch = {};
    if (typeof request.body.status === 'string') patch.status = request.body.status;
    if (typeof request.body.note === 'string') patch.note = request.body.note;
    patch.updatedAt = new Date();

    const db = await getDb();
    const result = await inquiriesCollection(db).findOneAndUpdate(
      { id: request.params.id },
      { $set: patch },
      { returnDocument: 'after' }
    );

    if (!result) {
      response.status(404).json({ message: 'Inquiry not found.' });
      return;
    }

    response.json(serializeInquiry(result));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.delete('/api/inquiries/:id', requireAdmin, requirePermission('inquiries'), async (request, response) => {
  try {
    const db = await getDb();
    await inquiriesCollection(db).deleteOne({ id: request.params.id });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/leads', requireAdmin, requirePermission('leads'), async (_request, response) => {
  try {
    const db = await getDb();
    const leads = await leadsCollection(db).find({}).sort({ updatedAt: -1, createdAt: -1 }).toArray();
    response.json(leads.map(serializeLead));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.post('/api/leads', requireAdmin, requirePermission('leads'), async (request, response) => {
  try {
    const lead = normalizeLead(request.body);
    if (!lead.company || !lead.email) {
      response.status(400).json({ message: 'Company name and email are required.' });
      return;
    }

    const db = await getDb();
    const existing = await leadsCollection(db).findOne({ email: lead.email });
    if (existing) {
      response.status(409).json({ message: 'A lead with this email already exists.' });
      return;
    }

    await leadsCollection(db).insertOne(lead);
    response.status(201).json(serializeLead(lead));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.patch('/api/leads/:id', requireAdmin, requirePermission('leads'), async (request, response) => {
  try {
    const allowed = ['company', 'contactName', 'email', 'phone', 'website', 'location', 'serviceInterest', 'source', 'status', 'remarks'];
    const patch = {};
    for (const key of allowed) {
      if (typeof request.body[key] === 'string') {
        patch[key] = key === 'email' ? request.body[key].trim().toLowerCase() : request.body[key].trim();
      }
    }
    patch.updatedAt = new Date();

    const db = await getDb();
    const result = await leadsCollection(db).findOneAndUpdate(
      { id: request.params.id },
      { $set: patch },
      { returnDocument: 'after' }
    );

    if (!result) {
      response.status(404).json({ message: 'Lead not found.' });
      return;
    }

    response.json(serializeLead(result));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.delete('/api/leads/:id', requireAdmin, requirePermission('leads'), async (request, response) => {
  try {
    const db = await getDb();
    await leadsCollection(db).deleteOne({ id: request.params.id });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.post('/api/leads/bulk-email', requireAdmin, requirePermission('leads'), async (request, response) => {
  try {
    const leadIds = Array.isArray(request.body.leadIds) ? request.body.leadIds : [];
    const subject = String(request.body.subject || '').trim();
    const message = String(request.body.message || '').trim();

    if (!leadIds.length || !subject || !message) {
      response.status(400).json({ message: 'Select leads and provide email subject and message.' });
      return;
    }

    const db = await getDb();
    const leads = await leadsCollection(db).find({ id: { $in: leadIds } }).toArray();
    const sendable = leads.filter((lead) => lead.email);
    const sentAt = new Date();
    const results = [];
    const failures = [];

    for (const lead of sendable) {
      const personalized = message
        .replaceAll('{{company}}', lead.company || '')
        .replaceAll('{{name}}', lead.contactName || lead.company || '');
      try {
        await sendMail({
          to: lead.email,
          subject,
          text: personalized
        });
        results.push({ id: lead.id, email: lead.email, ok: true });
      } catch (error) {
        failures.push({ id: lead.id, email: lead.email, ok: false, message: error.message });
      }
    }

    if (results.length) {
      await leadsCollection(db).updateMany(
        { id: { $in: results.map((lead) => lead.id) } },
        { $set: { lastEmailAt: sentAt, updatedAt: sentAt }, $inc: { emailCount: 1 } }
      );
    }

    if (!results.length && failures.length) {
      response.status(502).json({
        message: `No emails were sent. ${failures[0].message}`,
        sent: 0,
        failed: failures.length,
        failures
      });
      return;
    }

    response.json({ ok: true, sent: results.length, failed: failures.length, results, failures });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/users', requireAdmin, requireSuperAdmin, async (_request, response) => {
  try {
    const db = await getDb();
    const users = await usersCollection(db).find({}).sort({ createdAt: -1 }).toArray();
    response.json([superAdminUser(), ...users.map(serializeUser)]);
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.post('/api/users', requireAdmin, requireSuperAdmin, async (request, response) => {
  try {
    const { name, email, password, role, status, permissions } = request.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPassword = String(password || '');

    if (!cleanEmail || !cleanPassword) {
      response.status(400).json({ message: 'Email and password are required.' });
      return;
    }
    if (cleanEmail === adminEmail) {
      response.status(400).json({ message: 'The Super Admin user is managed from environment variables.' });
      return;
    }

    const db = await getDb();
    const existing = await usersCollection(db).findOne({ email: cleanEmail });
    if (existing) {
      response.status(409).json({ message: 'A user with this email already exists.' });
      return;
    }

    const { salt, hash } = hashPassword(cleanPassword);
    const now = new Date();
    const user = {
      id: new ObjectId().toString(),
      name: String(name || cleanEmail).trim(),
      email: cleanEmail,
      role: role || 'Editor',
      status: status || 'Active',
      permissions: Array.isArray(permissions) ? permissions.filter((item) => accessModules.includes(item)) : ['posts'],
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now,
      updatedAt: now
    };

    await usersCollection(db).insertOne(user);
    response.status(201).json(serializeUser(user));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.patch('/api/users/:id', requireAdmin, requireSuperAdmin, async (request, response) => {
  try {
    if (request.params.id === 'env-super-admin') {
      response.status(400).json({ message: 'The Super Admin user is managed from environment variables.' });
      return;
    }

    const patch = {};
    if (typeof request.body.name === 'string') patch.name = request.body.name.trim();
    if (typeof request.body.role === 'string') patch.role = request.body.role;
    if (typeof request.body.status === 'string') patch.status = request.body.status;
    if (Array.isArray(request.body.permissions)) {
      patch.permissions = request.body.permissions.filter((item) => accessModules.includes(item));
    }
    if (typeof request.body.password === 'string' && request.body.password.trim()) {
      const { salt, hash } = hashPassword(request.body.password.trim());
      patch.passwordSalt = salt;
      patch.passwordHash = hash;
    }
    patch.updatedAt = new Date();

    const db = await getDb();
    const result = await usersCollection(db).findOneAndUpdate(
      { id: request.params.id },
      { $set: patch },
      { returnDocument: 'after' }
    );

    if (!result) {
      response.status(404).json({ message: 'User not found.' });
      return;
    }

    response.json(serializeUser(result));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.delete('/api/users/:id', requireAdmin, requireSuperAdmin, async (request, response) => {
  try {
    if (request.params.id === 'env-super-admin') {
      response.status(400).json({ message: 'The Super Admin cannot be deleted.' });
      return;
    }

    const db = await getDb();
    await usersCollection(db).deleteOne({ id: request.params.id });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/posts', async (_request, response) => {
  try {
    const db = await getDb();
    const posts = await postsCollection(db).find({}).sort({ date: -1, updatedAt: -1 }).toArray();
    response.json(posts.map(serializePost));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.get('/api/posts/:slug', async (request, response) => {
  try {
    const db = await getDb();
    const post = await postsCollection(db).findOne({ slug: request.params.slug });
    if (!post) {
      response.status(404).json({ message: 'Post not found' });
      return;
    }
    response.json(serializePost(post));
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

app.listen(port, () => {
  console.log(`Kritech API running on port ${port}`);
});
