"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const { HttpError, calculateOrder, validateUtr, parseScreenshot, newOrderId, newCollectionToken, hashToken } = require("./lib/validate");
const { makeStaffAuth, rateLimiter } = require("./lib/auth");
const { QR_PREFIX } = require("./lib/mail");
const { createRazorpay } = require("./lib/razorpay");

const safeMsg = e => String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 200);
const withTimeout = (p, ms = 12000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
const ORDER_STATUSES = ["AWAITING_PAYMENT", "PENDING_REVIEW", "PAID", "REJECTED"];

// Staff-facing order view. Never includes token hashes, raw tokens, or screenshot hash.
const staffView = o => ({ orderId: o.orderId, createdAt: o.createdAt, name: o.name, email: o.email, rollNo: o.rollNo, phone: o.phone, batchYear: o.batchYear, items: o.items, total: o.total, currency: o.currency,
  paymentStatus: o.paymentStatus, upiReference: o.upiReference, paymentSubmittedAt: o.paymentSubmittedAt, verifiedAt: o.verifiedAt, verifiedBy: o.verifiedBy, rejectedAt: o.rejectedAt, rejectedBy: o.rejectedBy, rejectReason: o.rejectReason,
  paymentMethod: o.paymentMethod, razorpayPaymentId: o.razorpayPaymentId,
  collectionStatus: o.collectionStatus, collectedAt: o.collectedAt, collectedBy: o.collectedBy, hasScreenshot: Boolean(o.screenshotPath),
  sheetSynced: o.sheetSynced, sheetSyncError: o.sheetSyncError, ackEmailStatus: o.ackEmailStatus, qrEmailStatus: o.qrEmailStatus, qrEmailError: o.qrEmailError });

function createApp({ store, sheets, mail, razorpay, env = process.env, serveStatic = false }) {
  razorpay = razorpay || createRazorpay(env);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const staffAuth = makeStaffAuth(env.STAFF_TOKEN_HASHES);
  const submitLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  const rzCreateLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
  const rzVerifyLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 60 });

  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    if (/^\/(api|admin)\//.test(req.path)) res.set("Cache-Control", "no-store");
    next();
  });

  // ---- Razorpay webhook (needs the RAW body to check the signature, so it is registered before express.json) ----
  app.post("/api/razorpay/webhook", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : null;
      if (!raw || !razorpay.verifyWebhookSignature(raw, req.get("x-razorpay-signature"))) return res.status(400).json({ ok: false, error: "Invalid signature." });
      let evt; try { evt = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ ok: false, error: "Invalid payload." }); }
      if (!["payment.captured", "order.paid"].includes(evt.event)) return res.json({ ok: true, ignored: true });
      const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
      if (!pay || !/^pay_[A-Za-z0-9]{6,40}$/.test(String(pay.id)) || !/^order_[A-Za-z0-9]{6,40}$/.test(String(pay.order_id))) return res.json({ ok: true, ignored: true });
      const o = await store.findByRazorpayOrderId(pay.order_id);
      if (!o) return res.json({ ok: true, ignored: true });
      await finalizeRazorpayPayment(o, pay.id); // re-checks the payment with Razorpay's API; the webhook body alone is never trusted
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) { console.error("[razorpay-webhook] rejected", e.code || ""); return res.json({ ok: true, ignored: true }); }
      console.error("[razorpay-webhook] error", safeMsg(e)); res.status(500).json({ ok: false }); // 5xx makes Razorpay retry; the transition is idempotent
    }
  });
  app.use(express.json({ limit: "4mb" }));
  if (serveStatic) app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], dotfiles: "ignore" }));

  // ---- side effects: never lose the DB order; record outcome so it can be retried ----
  async function syncSheet(order) {
    try { await withTimeout(sheets.upsertOrder(order)); await store.patch(order.orderId, { sheetSynced: true, sheetSyncedAt: new Date().toISOString(), sheetSyncError: null }); return true; }
    catch (e) { console.error("[sheet-sync] failed", order.orderId, safeMsg(e)); try { await store.patch(order.orderId, { sheetSynced: false, sheetSyncError: safeMsg(e) }); } catch {} return false; }
  }
  async function sendAck(order) {
    try { await withTimeout(mail.sendAck(order)); await store.patch(order.orderId, { ackEmailStatus: "SENT", ackEmailError: null }); return true; }
    catch (e) { console.error("[ack-email] failed", order.orderId, safeMsg(e)); try { await store.patch(order.orderId, { ackEmailStatus: "FAILED", ackEmailError: safeMsg(e) }); } catch {} return false; }
  }
  async function sendQr(order, token) {
    try { await withTimeout(mail.sendQr(order, token)); await store.patch(order.orderId, { qrEmailSent: true, qrEmailStatus: "SENT", qrEmailError: null }); return true; }
    catch (e) { console.error("[qr-email] failed", order.orderId, safeMsg(e)); try { await store.patch(order.orderId, { qrEmailSent: false, qrEmailStatus: "FAILED", qrEmailError: safeMsg(e) }); } catch {} return false; }
  }

  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "IIT DH Merch Store API", testMode: true, unitPriceInr: 1, manualUpiEnabled: true,
    storeConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY), sheetsConfigured: sheets.configured, smtpConfigured: mail.configured, razorpayConfigured: razorpay.configured, razorpayMode: razorpay.configured ? razorpay.mode : null, razorpayWebhookConfigured: razorpay.webhookConfigured, staffAuthConfigured: staffAuth.configured }));
  app.get("/api/catalogue", (_req, res) => res.json({ products: [] }));
  app.post("/api/submit", (req, res) => req.body?.type === "visit" ? res.json({ ok: true }) : res.status(400).json({ ok: false, error: "Unsupported submission type." }));


  // ---- Razorpay: the server decides the amount; a payment counts only after Razorpay's own API confirms it ----
  async function finalizeRazorpayPayment(order, paymentId) {
    if (order.paymentStatus === "PAID") return { already: true, order };
    if (order.paymentStatus !== "AWAITING_PAYMENT" || order.paymentMethod !== "RAZORPAY") throw new HttpError(409, "This order can no longer accept a payment.");
    const expected = Math.round(order.total * 100);
    let pay;
    try { pay = await withTimeout(razorpay.fetchPayment(paymentId)); }
    catch (e) { console.error("[razorpay] fetch failed", order.orderId, safeMsg(e)); throw new HttpError(502, "Could not confirm the payment with Razorpay yet. Please wait a moment and retry."); }
    if (pay.order_id !== order.razorpayOrderId || pay.currency !== "INR" || Number(pay.amount) !== expected) { console.error("[razorpay] payment does not match order", order.orderId); throw new HttpError(409, "Payment details do not match this order.", "PAYMENT_MISMATCH"); }
    if (pay.status === "authorized") {
      try { pay = await withTimeout(razorpay.capturePayment(paymentId, expected)); }
      catch (e) { console.error("[razorpay] capture failed", order.orderId, safeMsg(e)); throw new HttpError(502, "Could not complete the payment capture. Please retry in a moment."); }
    }
    if (pay.status !== "captured") throw new HttpError(409, "Payment is not completed (status: " + String(pay.status).slice(0, 20) + ").", "PAYMENT_NOT_CAPTURED");
    const token = newCollectionToken();
    let paid;
    try { paid = await store.markPaidRazorpay(order.orderId, { razorpayOrderId: order.razorpayOrderId, paymentId, tokenHash: hashToken(token), now: new Date().toISOString() }); }
    catch (e) { if (e.code === "DUPLICATE_PAYMENT") throw new HttpError(409, "This payment was already applied to another order.", "DUPLICATE_PAYMENT"); throw e; }
    if (!paid) { // lost a race (checkout verify vs webhook): fine if the winner used this same payment
      const cur = await store.getOrder(order.orderId);
      if (cur && cur.paymentStatus === "PAID" && cur.razorpayPaymentId === paymentId) return { already: true, order: cur };
      throw new HttpError(409, "Order changed. Please refresh.");
    }
    const [sheetOk, qrOk] = await Promise.all([syncSheet(paid), sendQr(paid, token)]);
    return { order: paid, sheetOk, qrOk };
  }

  app.post("/api/razorpay/create-order", async (req, res, next) => {
    try {
      if (!razorpay.configured) throw new HttpError(503, "Online payment is not available right now. Please use the UPI QR option.");
      if (!rzCreateLimit(req.ip || "?")) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
      const details = calculateOrder(req.body); // prices/totals from the browser are never read
      const orderId = newOrderId(), amountPaise = Math.round(details.total * 100);
      let rz;
      try { rz = await withTimeout(razorpay.createOrder({ amountPaise, receipt: orderId, notes: { orderId } })); }
      catch (e) { console.error("[razorpay] create order failed", safeMsg(e)); throw new HttpError(502, "Could not start the payment. Please try again."); }
      if (!rz || !/^order_[A-Za-z0-9]{6,40}$/.test(String(rz.id)) || Number(rz.amount) !== amountPaise) throw new HttpError(502, "Could not start the payment. Please try again.");
      await store.insertRazorpayAwaiting({ orderId, ...details, razorpayOrderId: rz.id });
      res.status(201).json({ ok: true, orderId, razorpayOrderId: rz.id, keyId: razorpay.keyId, amountPaise, currency: "INR" });
    } catch (e) { next(e); }
  });

  app.post("/api/razorpay/verify", async (req, res, next) => {
    try {
      if (!razorpay.configured) throw new HttpError(503, "Online payment is not available right now.");
      if (!rzVerifyLimit(req.ip || "?")) throw new HttpError(429, "Too many attempts. Please wait and try again.");
      const b = req.body || {}, orderId = String(b.orderId || ""), rzOrder = String(b.razorpay_order_id || ""), rzPay = String(b.razorpay_payment_id || "");
      if (!/^IITDH-\d{8}-[A-F0-9]{8}$/.test(orderId) || !/^order_[A-Za-z0-9]{6,40}$/.test(rzOrder) || !/^pay_[A-Za-z0-9]{6,40}$/.test(rzPay)) throw new HttpError(400, "Invalid payment details.");
      if (!razorpay.verifyCheckoutSignature(rzOrder, rzPay, b.razorpay_signature)) throw new HttpError(400, "Payment signature check failed. If money was deducted, it will be matched automatically or refunded; contact the merch team with your order ID.", "BAD_SIGNATURE");
      const o = await store.getOrder(orderId);
      if (!o || o.paymentMethod !== "RAZORPAY" || o.razorpayOrderId !== rzOrder) throw new HttpError(404, "Order not found.");
      const r = await finalizeRazorpayPayment(o, rzPay);
      res.json({ ok: true, orderId, paymentStatus: "PAID", alreadyConfirmed: Boolean(r.already), collectionQrEmailed: r.already ? r.order.qrEmailStatus === "SENT" : r.qrOk, vendorSheetUpdated: r.already ? r.order.sheetSynced === true : r.sheetOk,
        message: "Payment confirmed by Razorpay." });
    } catch (e) { next(e); }
  });

  // ---- student: create order, then attach UTR + screenshot. Result is ALWAYS PENDING_REVIEW, never PAID. ----
  app.post("/api/submit-upi-order", async (req, res, next) => {
    let orderId = null, proofPath = null, created = false; // eslint-disable-line no-unused-vars
    try {
      if (!submitLimit(req.ip || "?")) throw new HttpError(429, "Too many submissions. Please wait a few minutes and try again.");
      const details = calculateOrder(req.body);
      const utr = validateUtr(req.body.upiReference);
      const shot = parseScreenshot(req.body.screenshot);
      const dup = await store.findDuplicates({ utr, hash: shot.hash });
      if (dup.utr) throw new HttpError(409, "This UPI reference has already been submitted.");
      if (dup.hash) throw new HttpError(409, "This screenshot has already been submitted for another order.");
      orderId = newOrderId();
      await store.insertAwaiting({ orderId, ...details }); created = true;
      proofPath = `orders/${orderId}/${shot.hash.slice(0, 16)}.${shot.ext}`;
      try { await store.uploadProof(proofPath, shot.buf, shot.mime); }
      catch (e) { await store.discardAwaiting(orderId).catch(() => {}); created = false; throw e; }
      let order;
      try { order = await store.submitEvidence(orderId, { utr, path: proofPath, hash: shot.hash, submittedAt: new Date().toISOString() }); }
      catch (e) {
        await store.removeProof(proofPath).catch(() => {}); await store.discardAwaiting(orderId).catch(() => {}); created = false;
        if (e.code === "DUPLICATE_UTR") throw new HttpError(409, "This UPI reference has already been submitted.");
        if (e.code === "DUPLICATE_SCREENSHOT") throw new HttpError(409, "This screenshot has already been submitted for another order.");
        throw e;
      }
      if (!order) throw new Error("order state changed unexpectedly");
      const [sheetOk, ackOk] = await Promise.all([syncSheet(order), sendAck(order)]);
      res.status(201).json({ ok: true, orderId, paymentStatus: order.paymentStatus, total: order.total, acknowledgementEmailed: ackOk, vendorSheetUpdated: sheetOk,
        message: "Order received. Payment is PENDING verification by staff; your collection QR is emailed only after the payment is verified." });
    } catch (e) { next(e); } // an AWAITING_PAYMENT row can remain only if a post-upload step failed; it is harmless (never paid, never emailed)
  });

  // ---- staff: review ----
  app.get("/admin/orders", staffAuth, async (req, res, next) => {
    try {
      const status = String(req.query.status || "PENDING_REVIEW"); if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, "Invalid status filter.");
      res.json({ ok: true, staff: req.staff, orders: (await store.listOrders(status)).map(staffView) });
    } catch (e) { next(e); }
  });
  app.get("/admin/orders/:orderId/screenshot-url", staffAuth, async (req, res, next) => {
    try {
      const o = await store.getOrder(req.params.orderId);
      if (!o || !o.screenshotPath) throw new HttpError(404, "No screenshot for this order.");
      res.json({ ok: true, url: await store.signedProofUrl(o.screenshotPath, 120), expiresInSeconds: 120 });
    } catch (e) { next(e); }
  });
  app.post("/admin/orders/:orderId/approve-upi", staffAuth, async (req, res, next) => {
    try {
      const o = await store.getOrder(req.params.orderId);
      if (!o) throw new HttpError(404, "Order not found.");
      if (o.paymentStatus === "PAID") return res.json({ ok: true, alreadyApproved: true, orderId: o.orderId, paymentStatus: "PAID", message: "Order was already approved. Nothing was changed or re-sent." });
      if (o.paymentStatus !== "PENDING_REVIEW") throw new HttpError(409, "Order is not awaiting review.");
      const b = req.body || {};
      if (b.confirmBankVerified !== true) throw new HttpError(400, "Confirm that the transaction and exact amount were verified in the bank/UPI account.");
      if (String(b.confirmedUtr || "").trim().toLowerCase() !== String(o.upiReference || "").toLowerCase()) throw new HttpError(400, "The UTR you typed does not match the order's UTR.");
      if (!Number.isFinite(Number(b.confirmedAmount)) || Math.round(Number(b.confirmedAmount) * 100) !== Math.round(o.total * 100)) throw new HttpError(400, "The credited amount you typed does not match the order total.");
      const token = newCollectionToken();
      const order = await store.approve(o.orderId, { staff: req.staff, tokenHash: hashToken(token), now: new Date().toISOString() });
      if (!order) throw new HttpError(409, "Order was just changed by someone else. Refresh and check its status.");
      const [sheetOk, qrOk] = await Promise.all([syncSheet(order), sendQr(order, token)]);
      res.json({ ok: true, orderId: order.orderId, paymentStatus: "PAID", verifiedBy: order.verifiedBy, sheetUpdated: sheetOk, collectionQrEmailed: qrOk,
        message: qrOk ? "Payment approved. Collection QR emailed." : "Payment approved, but the QR email failed. Use 'Resend QR'." });
    } catch (e) { next(e); }
  });
  app.post("/admin/orders/:orderId/reject", staffAuth, async (req, res, next) => {
    try {
      const reason = String(req.body?.reason || "").trim().slice(0, 300);
      if (reason.length < 3 || /[\u0000-\u001f]/.test(reason)) throw new HttpError(400, "Give a short reason for rejecting.");
      const order = await store.reject(req.params.orderId, { staff: req.staff, reason, now: new Date().toISOString() });
      if (!order) throw new HttpError(409, "Only orders awaiting review can be rejected.");
      const sheetOk = await syncSheet(order);
      res.json({ ok: true, orderId: order.orderId, paymentStatus: "REJECTED", sheetUpdated: sheetOk });
    } catch (e) { next(e); }
  });
  app.post("/admin/orders/:orderId/retry-sync", staffAuth, async (req, res, next) => {
    try {
      const o = await store.getOrder(req.params.orderId); if (!o) throw new HttpError(404, "Order not found.");
      res.json({ ok: true, orderId: o.orderId, sheetUpdated: await syncSheet(o) });
    } catch (e) { next(e); }
  });
  app.post("/admin/orders/:orderId/resend-qr", staffAuth, async (req, res, next) => {
    try {
      const o = await store.getOrder(req.params.orderId); if (!o) throw new HttpError(404, "Order not found.");
      if (o.paymentStatus !== "PAID" || o.collectionStatus !== "READY") throw new HttpError(409, "A QR can only be sent for a verified, uncollected order.");
      if (o.qrEmailStatus === "SENT" && req.body?.resend !== true) throw new HttpError(409, "A QR was already emailed. Resend with confirmation to issue a replacement (the old QR will stop working).");
      const token = newCollectionToken();
      const order = await store.rotateToken(o.orderId, hashToken(token), new Date().toISOString());
      if (!order) throw new HttpError(409, "Order changed (possibly collected). Refresh.");
      res.json({ ok: true, orderId: order.orderId, collectionQrEmailed: await sendQr(order, token) });
    } catch (e) { next(e); }
  });

  // ---- staff: collection (QR redeemable once; single guarded UPDATE) ----
  const parseQr = raw => { const v = String(raw || "").trim(); const t = v.startsWith(QR_PREFIX) ? v.slice(QR_PREFIX.length) : v; if (!/^[A-Za-z0-9_-]{30,100}$/.test(t)) throw new HttpError(400, "Invalid collection QR."); return t; };
  app.post("/api/collection/lookup", staffAuth, async (req, res, next) => {
    try {
      const o = await store.findByTokenHash(hashToken(parseQr(req.body?.token)));
      if (!o) throw new HttpError(404, "QR not recognised.");
      res.json({ ok: true, order: staffView(o) });
    } catch (e) { next(e); }
  });
  app.post("/api/collection/redeem", staffAuth, async (req, res, next) => {
    try {
      const hash = hashToken(parseQr(req.body?.token));
      const order = await store.redeem(hash, { staff: req.staff, now: new Date().toISOString() });
      if (!order) {
        const o = await store.findByTokenHash(hash);
        if (!o) throw new HttpError(404, "QR not recognised.");
        if (o.collectionStatus === "COLLECTED") throw new HttpError(409, `Already collected on ${o.collectedAt}${o.collectedBy ? " by " + o.collectedBy : ""}. Do NOT hand over merchandise again.`, "ALREADY_COLLECTED");
        throw new HttpError(409, "Payment is not verified. Do NOT hand over merchandise.");
      }
      const sheetOk = await syncSheet(order);
      res.json({ ok: true, orderId: order.orderId, collectionStatus: "COLLECTED", collectedAt: order.collectedAt, collectedBy: order.collectedBy, sheetUpdated: sheetOk, message: "Collection recorded. This QR cannot be used again." });
    } catch (e) { next(e); }
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
    if (err.type === "entity.too.large") return res.status(413).json({ ok: false, error: "Request too large. Use a smaller screenshot." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "Invalid request." });
    console.error("[error]", err.name, safeMsg(err), err.cause || ""); // no request bodies / PII in logs
    res.status(500).json({ ok: false, error: "Something went wrong. Please try again." });
  });
  return app;
}

function createDefaultApp(opts = {}) {
  const { createStore } = require("./lib/store"), { createSheets } = require("./lib/sheets"), { createMail } = require("./lib/mail");
  const env = process.env;
  const lazy = {};
  // Lazy store so /api/health still works (and reports not-configured) when Supabase vars are missing.
  const store = new Proxy({}, { get: (_t, k) => (...a) => { if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Supabase is not configured"); return (lazy.s || (lazy.s = createStore({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY })))[k](...a); } });
  return createApp({ store, sheets: createSheets(env), mail: createMail(env), razorpay: createRazorpay(env), env, ...opts });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createDefaultApp({ serveStatic: true }).listen(port, () => console.log(`IIT DH Merch Store (₹1 TEST MODE) on http://localhost:${port}  health: /api/health`));
}
const defaultApp = createDefaultApp();
module.exports = defaultApp; module.exports.createApp = createApp;
