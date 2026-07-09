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
- `FRONTEND_URL`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_UPLOAD_FOLDER`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
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

Set `FRONTEND_URL` to the same public site URL so password reset emails generate the correct `/admin-reset` link. SMTP variables are required for lead bulk email and password reset email delivery.

## Endpoints

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/request-reset`
- `POST /api/auth/reset-password`
- `GET /api/auth/me`
- `GET /api/content`
- `PUT /api/content`
- `POST /api/cloudinary/signature`
- `POST /api/inquiries`
- `GET /api/inquiries`
- `PATCH /api/inquiries/:id`
- `DELETE /api/inquiries/:id`
- `GET /api/leads`
- `POST /api/leads`
- `PATCH /api/leads/:id`
- `DELETE /api/leads/:id`
- `POST /api/leads/bulk-email`
- `GET /api/mail/status`
- `POST /api/mail/test`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/posts`
- `GET /api/posts/:slug`
