# IIT Dharwad Merch Store — ₹1 TEST MODE

Every item costs exactly **₹1** (prices are enforced on the server only; coupons are disabled). This is a test build, not a real-price store.

## Payment option 1: Razorpay (default)
1. The browser sends only the student's details and product choices. The **server** prices the cart (₹1 per item in test mode) and creates the Razorpay order for that exact amount.
2. The student pays in Razorpay Checkout. The browser returns a signed result to `/api/razorpay/verify`.
3. The server checks the signature **and then asks Razorpay's API** whether that payment is captured, for this order, in INR, for the exact amount. Only then is the order `PAID` (one atomic update; the database refuses `PAID` without a matching Razorpay order and payment id).
4. The sheet row is written, and the collection QR is emailed. A signed webhook (`/api/razorpay/webhook`) does the same if the student closes the tab; it re-checks with Razorpay's API too, so it is idempotent.
Keys: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (see `.env.example`). Start with **test** keys.

## Payment option 2: manual UPI, staff-verified
1. Student pays by UPI QR, then submits their UTR and a payment screenshot.
2. The server creates the order (`AWAITING_PAYMENT`), stores the screenshot in the **private** Supabase bucket `payment-proofs`, then sets it to **`PENDING_REVIEW`**. A student request can never make an order `PAID`.
3. The student gets an email saying *payment pending verification* (no QR). The vendor Google Sheet shows the row as *PENDING VERIFICATION (not paid)*.
4. Staff open `/upi-review.html`, view the screenshot through a 2-minute signed link, then check the **bank/UPI account**. To approve they must type the exact UTR and credited amount seen in the bank and tick the confirmation. Only then does the order become `PAID` (verifier + time recorded), the sheet row updates, and the collection QR is emailed.
5. At `/collection-staff.html`, staff scan the QR. A QR works once (a single atomic database update), and the collector is recorded.

A screenshot or UTR is **not** proof of payment. The database itself refuses `PAID` without a verifier, QR/READY while pending, a second collection, or reverting a paid/collected order.

## Setup
- Hosting: Vercel (`api/index.js` + `vercel.json`); static pages from `public/`.
- Database: apply `supabase/migrations/*` (already applied to project `kpqtgiywngjkspkuokgk`).
- Environment variables: see `.env.example`. Create staff tokens with `node scripts/make-staff-token.js "Name"`.
- Tests: `npm test` (no external services needed).
- Health: `/api/health` (reports only whether things are configured).

## Before real prices
Update prices in both `public/config.js` and `lib/validate.js` (`PRODUCT_PRICES`), re-enable fees/coupons deliberately, and re-test totals.

## Known limits
- Rate limiting is in-memory per serverless instance (best-effort); add Vercel Firewall rules for stronger protection.
- Visit analytics are no longer stored (there is no durable local disk on Vercel).
