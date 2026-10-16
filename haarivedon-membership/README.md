# HaarivedOn – 365-Day Membership & Draftsmanship Course landing page

Zero-dependency Node.js app (Node 18+). Serves the landing page, creates Razorpay orders,
verifies payments server-side and stores every lead for follow-up.

## Run
1. Copy `.env.example` to `.env` and fill in:
   - `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` – from your Razorpay dashboard (keep the secret private, never put it in the HTML).
   - `ADMIN_PASSWORD` – password for the leads dashboard.
   - `LEADS_WEBHOOK_URL` (optional) – e.g. a Google Apps Script / Zapier URL to also copy every lead into Google Sheets.
2. `npm start` (or `node server.js`) → http://localhost:3000

Host it on any Node host (Render, Railway, a VPS, Hostinger VPS, etc.) behind **HTTPS** – Razorpay and iOS Safari require HTTPS in production.

## Pages
- `/` – landing page (membership ₹2,100 · course ₹5,100/month)
- `/thank-you.html` – shown after successful payment
- `/admin.html` – leads & payments dashboard (filter, call/WhatsApp, CSV download)

## Payment flow
Form → `POST /api/lead` (saved as `lead`) → `POST /api/order` (Razorpay order, price set on server) →
Razorpay Checkout → `POST /api/verify` (HMAC signature check, status `paid`) → thank-you page.
Inside Instagram/Facebook in-app browsers the checkout uses Razorpay redirect mode (`/api/razorpay/callback`).
Lead statuses: `lead`, `checkout_started`, `checkout_dismissed`, `payment_failed`, `verification_failed`, `paid`.
"Get Course Details" saves the lead only (intent `details`), no payment.

Leads are stored in `data/leads.json` on traditional servers. On serverless platforms (Vercel, AWS Lambda), `/var/task` is read-only, so the app automatically writes to the temporary folder `/tmp` and recovers state across containers seamlessly. To permanently save leads on Vercel, simply set `LEADS_WEBHOOK_URL` (e.g. to save in Google Sheets) or `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`.

## Edit prices
Change amounts (in paise) in `PRODUCTS` in `server.js` and the displayed prices in `public/index.html`.
