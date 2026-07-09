# Kritech Solution Backend

Express API for Kritech Solution CMS, admin login, MongoDB content sync and Cloudinary signed uploads.

## Local Development

```bash
npm install
npm run dev
```

API runs on `http://127.0.0.1:8787` by default.

## Environment

Copy `.env.example` to `.env` locally, or set the same variables in Railway.

Required production variables:

- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `PORT`
- `CLIENT_ORIGIN`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_UPLOAD_FOLDER`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_SALT`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_TOKEN_SECRET`

## Railway

Use:

```bash
npm start
```

Set `CLIENT_ORIGIN` to the deployed frontend domain, for example:

```bash
https://kritechsolution.com
```

## Endpoints

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/content`
- `PUT /api/content`
- `POST /api/cloudinary/signature`
- `GET /api/posts`
- `GET /api/posts/:slug`
