# IIT Dharwad Merch Store — ₹1 Test Mode + UPI UTR + Collection QR

This deployment-preparation package is configured for **₹1 per item test mode**. It is not a production-price store. Do not advertise it as normal merchandise pricing.

## What this version does
- Every product costs exactly ₹1 per item, including XXL/custom-name options. Coupons are disabled so the total cannot be reduced by a coupon.
- Students submit their UPI UTR/reference and payment screenshot.
- The order is recorded as `PAID` with `verificationSource: self_reported`; this is **not bank verification**. When SMTP is configured, the collection QR is emailed after submission.
- There is no separate website approval queue.
- At distribution, staff must check the UTR and exact credited amount in the receiving bank/UPI account. The collection scanner requires a staff member to tick the bank-verification checkbox before recording collection. The QR alone is not proof of payment.
- Google Sheets and SMTP are retained as integrations, configured with environment variables.

## Important: persistence and hosting
The server stores order records and payment screenshots in `DATA_DIR`. For Render, configure a **persistent disk** mounted at `/var/data` and set `DATA_DIR=/var/data`. A persistent disk generally requires a paid Render service; check Render's current pricing before creating a service. Do not accept orders on a free/ephemeral filesystem because orders/screenshots can disappear after restart or redeploy.

A `render.yaml` is included for a Node web service. Review its plan and costs in Render before deploying. This ZIP does not deploy anything by itself.

## Local setup
1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in valid Google Sheets, SMTP, and `ADMIN_TOKEN` settings. Do not share or upload `.env`.
4. Run `npm start` and open `http://localhost:3000`.
5. Staff collection page: `/collection-staff.html`.
6. Health check: `/api/health`.

## Environment variables
- `PORT`: supplied by the host automatically.
- `DATA_DIR`: persistent writable directory; for Render disk use `/var/data`.
- `GOOGLE_SERVICE_ACCOUNT_JSON_B64`: base64-encoded service-account JSON.
- `GOOGLE_SHEETS_SPREADSHEET_ID`: spreadsheet ID.
- `GOOGLE_SHEETS_TAB`: defaults to `Orders`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: outbound email.
- `ADMIN_TOKEN`: long random secret used by staff collection APIs.

Never commit `.env`, service-account credentials, SMTP passwords, or the admin token. Configure secrets in the host's environment-variable dashboard.

## Google Sheets
The code expects the Orders tab to have these headers in order: `Order ID | Created At | Student Name | Institute Email | Roll Number | Phone | Batch/Program | Items | Subtotal | Discount | Coupon | Total | Currency | Payment Status | Payment Method | UPI Reference | Paid At | Collection Status | Collected At | Screenshot`.

## Before using with real prices
This is deliberately a ₹1 test build. Before selling at real prices, update both `config.js` and the server-side `PRODUCT_PRICES`, restore intended option fees/coupons, and test totals end-to-end. Confirm the receiving account's UPI ID is correct. Screenshots and UTRs are user-submitted and can be forged or reused; staff must verify actual bank credit before distribution.
