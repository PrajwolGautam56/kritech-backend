import 'dotenv/config';
import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
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

function serializePost(post) {
  if (!post) return post;
  const { _id, ...rest } = post;
  return {
    ...rest,
    id: rest.id || _id?.toString()
  };
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
  const hash = crypto.pbkdf2Sync(password, adminPasswordSalt, 120000, 32, 'sha256').toString('hex');
  if (Buffer.byteLength(hash) !== Buffer.byteLength(adminPasswordHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(adminPasswordHash));
}

function requireAdmin(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const session = verifyToken(token);
  if (!session || session.email !== adminEmail) {
    response.status(401).json({ message: 'Admin login required.' });
    return;
  }
  request.admin = session;
  next();
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

  if (email !== adminEmail || !verifyPassword(password)) {
    response.status(401).json({ message: 'Invalid email or password.' });
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + (60 * 60 * 12);
  response.json({
    token: signToken({ email: adminEmail, role: 'admin', exp: expiresAt }),
    admin: { email: adminEmail, role: 'admin' },
    expiresAt
  });
});

app.get('/api/auth/me', requireAdmin, (request, response) => {
  response.json({ admin: { email: request.admin.email, role: request.admin.role } });
});

app.post('/api/cloudinary/signature', requireAdmin, (_request, response) => {
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

app.put('/api/content', requireAdmin, async (request, response) => {
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
