# Swadisht Hotel Management Agent

Centralized web app for hotel/restaurant operations with WhatsApp-driven ordering.

## Features
- WhatsApp order intake (`ORDER: Item xQty`)
- Bill generation from menu with `5% GST`
- Instant payment QR/UPI link after order
- Delivery update + WhatsApp rating request
- Daily offer broadcast to previous customers
- Centralized dashboard with:
  - Orders, customers, feedback, offers
  - Menu sales analytics
  - KPI analytics (`ARPU`, `MRPU`, delivery rate, repeat rate, retention, rating stats)

## Tech Stack
- Node.js + Express
- SQLite
- Plain HTML/CSS/JS dashboard
- WhatsApp providers: `mock`, `twilio`, `meta`

## Run Locally
```bash
npm install
copy .env.example .env
npm start
```

Open `http://localhost:3000`

## Environment
Use `.env.example` as template.

Provider values:
- `WHATSAPP_PROVIDER=mock|twilio|meta`
- Twilio:
  - `WHATSAPP_TWILIO_ACCOUNT_SID`
  - `WHATSAPP_TWILIO_AUTH_TOKEN`
  - `WHATSAPP_TWILIO_FROM`
- Meta:
  - `WHATSAPP_META_TOKEN`
  - `WHATSAPP_META_PHONE_NUMBER_ID`
  - `WHATSAPP_META_VERIFY_TOKEN`

## Main APIs
- `GET /api/health`
- `GET /api/menu`
- `POST /api/menu/upload-csv`
- `POST /api/orders`
- `GET /api/orders`
- `POST /api/orders/:id/delivered`
- `POST /api/offers/send`
- `GET /api/customers`
- `GET /api/feedback`
- `GET /api/offers`
- `GET /api/menu-sales?days=30`
- `GET /api/analytics?days=30`
- `POST /api/demo/seed`

## Web App Results (Demo)
Seeded demo dataset and validated analytics from the running app:

- Inserted customers: `1000`
- Inserted orders: `2473`
- Inserted feedback: `1176`
- KPI ARPU: `294.74`
- KPI MRPU: `815.82`
- KPI Avg Rating: `3.33`
- Menu items tracked in sales: `16`

## Webhook Routes
- Generic local test: `POST /api/whatsapp/webhook`
- Twilio: `POST /api/whatsapp/webhook/twilio`
- Meta verify: `GET /api/whatsapp/webhook/meta`
- Meta events: `POST /api/whatsapp/webhook/meta`

## Business Branding
Dashboard brand name: **Swadisht**
