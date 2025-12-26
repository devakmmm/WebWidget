# WebSocket Chat Widget (SaaS MVP)

Drop-in widget you can embed on any site:

```html
<script src="https://YOUR-RENDER-URL/widget.js" data-site="acme-gym"></script>
```

## Features (MVP)
- Rooms per site via `data-site`
- Floating embeddable widget
- WebSocket messaging + presence
- Solo bot (`BOT-NEON`) when a visitor is alone
- Postgres persistence if `DATABASE_URL` is set (fallback to in-memory)
- Optional email notifications (SMTP env vars)

## Local run
```bash
npm install
npm start
```
Demo: http://localhost:3000/demo  
Widget test: http://localhost:3000/widget-test

## Render env vars (optional but recommended)
- `DATABASE_URL` (Render Postgres)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM`
