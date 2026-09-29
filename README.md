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
- `JSON_BODY_LIMIT` (recommended: `25mb`)
- `CLIENT_ORIGIN`
- `FRONTEND_URL`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_UPLOAD_FOLDER`
- `MAIL_FROM`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_SALT`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_TOKEN_SECRET`
- `SAMAYA_SMS_API_KEY`
- `SAMAYA_SMS_CAMPAIGN_ID`
- `SAMAYA_SMS_ROUTE_ID`
- `SAMAYA_SMS_SENDER_ID`

Set `ADMIN_TOKEN_SECRET` to a long random value and keep it unchanged. If this value changes, existing admin sessions expire and the dashboard will ask you to login again.

## Railway

Use:

```bash
npm start
```

Set `CLIENT_ORIGIN` to the deployed frontend domain, for example:

```bash
https://kritechsolution.com
```

Set `FRONTEND_URL` to the same public site URL so password reset emails generate the correct `/admin-reset` link.

For reliable production mail, set `MAIL_PROVIDER=auto` and add either `RESEND_API_KEY` or `BREVO_API_KEY`. SMTP variables can stay as a fallback, but API mail avoids Railway-to-SMTP connection timeouts.

The SMS API key is server-only. Add the SamayaSMS variables to Railway and never add them to Vercel or any `VITE_` variable. Because a key included in chat or documentation should be treated as exposed, rotate it in SamayaSMS before production use.

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
- `GET /api/sms/overview`
- `GET /api/sms/bootstrap`
- `GET /api/sms/campaign-status`
- `GET /api/sms/contacts`
- `POST /api/sms/contacts/import`
- `DELETE /api/sms/contacts/:id`
- `GET /api/sms/campaigns`
- `POST /api/sms/campaigns`
- `GET /api/sms/campaigns/:id/deliveries`
- `POST /api/sms/campaigns/:id/sync-dlr`
