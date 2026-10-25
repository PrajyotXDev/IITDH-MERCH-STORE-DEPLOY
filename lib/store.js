"use strict";
// Supabase-backed store. Every state transition is ONE guarded UPDATE ... WHERE (atomic in Postgres),
// backed by DB constraints + trigger (see supabase/migrations). Uses the server-only secret key.
const { createClient } = require("@supabase/supabase-js");
const BUCKET = "payment-proofs";

const fromRow = r => r && ({
  orderId: r.order_id, createdAt: r.created_at, name: r.customer_name, email: r.customer_email, rollNo: r.roll_number, phone: r.phone,
  batchYear: r.batch_program, items: r.items, subtotal: Number(r.subtotal), discount: Number(r.discount), couponCode: r.coupon || "", total: Number(r.total),
  currency: r.currency, paymentStatus: r.payment_status, paymentMethod: r.payment_method, upiReference: r.upi_reference, paymentSubmittedAt: r.payment_submitted_at,
  paidAt: r.paid_at, verifiedAt: r.verified_at, verifiedBy: r.verified_by, verificationSource: r.verification_source, rejectedAt: r.rejected_at, rejectedBy: r.rejected_by, rejectReason: r.reject_reason,
  collectionStatus: r.collection_status, collectedAt: r.collected_at, collectedBy: r.collected_by, screenshotPath: r.screenshot_path,
  sheetSynced: r.sheet_synced, sheetSyncedAt: r.sheet_synced_at, sheetSyncError: r.sheet_sync_error,
  razorpayOrderId: r.razorpay_order_id, razorpayPaymentId: r.razorpay_payment_id, ackEmailStatus: r.ack_email_status, qrEmailSent: r.qr_email_sent, qrEmailStatus: r.qr_email_status, qrEmailError: r.qr_email_error,
});
const PATCHABLE = { sheetSynced: "sheet_synced", sheetSyncedAt: "sheet_synced_at", sheetSyncError: "sheet_sync_error", ackEmailStatus: "ack_email_status", ackEmailError: "ack_email_error", qrEmailSent: "qr_email_sent", qrEmailStatus: "qr_email_status", qrEmailError: "qr_email_error" };

function createStore({ url, secretKey, client }) {
  const sb = client || createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const orders = () => sb.from("orders");
  const fail = (e, what) => { const err = new Error(what + " failed"); err.cause = e && e.code; throw err; };
  const one = (res, what) => { if (res.error) fail(res.error, what); return res.data && res.data.length ? fromRow(res.data[0]) : null; };
  return {
    async findDuplicates({ utr, hash }) {
      const a = await orders().select("order_id").ilike("upi_reference", utr).limit(1);
      const b = await orders().select("order_id").eq("screenshot_sha256", hash).limit(1);
      if (a.error || b.error) fail(a.error || b.error, "duplicate check");
      return { utr: a.data.length > 0, hash: b.data.length > 0 };
    },
    async insertAwaiting(o) {
      const res = await orders().insert({ order_id: o.orderId, customer_name: o.name, customer_email: o.email, roll_number: o.rollNo, phone: o.phone, batch_program: o.batchYear,
        items: o.items, subtotal: o.subtotal, discount: o.discount, coupon: o.couponCode || null, total: o.total, currency: "INR", payment_status: "AWAITING_PAYMENT", payment_method: "UPI", collection_status: "NOT_READY" }).select();
      return one(res, "insert order");
    },
    async insertRazorpayAwaiting(o) {
      const res = await orders().insert({ order_id: o.orderId, customer_name: o.name, customer_email: o.email, roll_number: o.rollNo, phone: o.phone, batch_program: o.batchYear,
        items: o.items, subtotal: o.subtotal, discount: o.discount, coupon: o.couponCode || null, total: o.total, currency: "INR", payment_status: "AWAITING_PAYMENT", payment_method: "RAZORPAY", razorpay_order_id: o.razorpayOrderId, collection_status: "NOT_READY" }).select();
      return one(res, "insert razorpay order");
    },
    async findByRazorpayOrderId(id) { return one(await orders().select("*").eq("razorpay_order_id", id).limit(1), "razorpay lookup"); },
    // Atomic: only an AWAITING_PAYMENT Razorpay order whose gateway order id matches can become PAID.
    async markPaidRazorpay(orderId, { razorpayOrderId, paymentId, tokenHash, now }) {
      const res = await orders().update({ payment_status: "PAID", paid_at: now, verified_at: now, verified_by: "Razorpay", verification_source: "razorpay_verified", razorpay_payment_id: paymentId,
        collection_status: "READY", collection_token_hash: tokenHash, collection_token_issued_at: now, qr_email_status: "NOT_SENT", qr_email_sent: false })
        .eq("order_id", orderId).eq("payment_method", "RAZORPAY").eq("razorpay_order_id", razorpayOrderId).eq("payment_status", "AWAITING_PAYMENT").select();
      if (res.error && res.error.code === "23505") { const e = new Error("duplicate payment"); e.code = "DUPLICATE_PAYMENT"; throw e; }
      return one(res, "mark paid");
    },
    async submitEvidence(orderId, { utr, path, hash, submittedAt }) {
      const res = await orders().update({ payment_status: "PENDING_REVIEW", upi_reference: utr, screenshot_path: path, screenshot_sha256: hash, payment_submitted_at: submittedAt })
        .eq("order_id", orderId).eq("payment_status", "AWAITING_PAYMENT").select();
      if (res.error && res.error.code === "23505") { const e = new Error("duplicate"); e.code = /screenshot/i.test(res.error.message) ? "DUPLICATE_SCREENSHOT" : "DUPLICATE_UTR"; throw e; }
      return one(res, "submit evidence");
    },
    async discardAwaiting(orderId) { await orders().delete().eq("order_id", orderId).eq("payment_status", "AWAITING_PAYMENT"); },
    async getOrder(orderId) { return one(await orders().select("*").eq("order_id", orderId).limit(1), "get order"); },
    async listOrders(status) {
      const res = await orders().select("*").eq("payment_status", status).order("created_at", { ascending: false }).limit(200);
      if (res.error) fail(res.error, "list orders");
      return res.data.map(fromRow);
    },
    async approve(orderId, { staff, tokenHash, now }) {
      return one(await orders().update({ payment_status: "PAID", paid_at: now, verified_at: now, verified_by: staff, verification_source: "manual_bank_verified",
        collection_status: "READY", collection_token_hash: tokenHash, collection_token_issued_at: now, qr_email_status: "NOT_SENT", qr_email_sent: false })
        .eq("order_id", orderId).eq("payment_status", "PENDING_REVIEW").select(), "approve");
    },
    async reject(orderId, { staff, reason, now }) {
      return one(await orders().update({ payment_status: "REJECTED", rejected_at: now, rejected_by: staff, reject_reason: reason })
        .eq("order_id", orderId).eq("payment_status", "PENDING_REVIEW").select(), "reject");
    },
    async findByTokenHash(hash) { return one(await orders().select("*").eq("collection_token_hash", hash).limit(1), "token lookup"); },
    async redeem(tokenHash, { staff, now }) {
      return one(await orders().update({ collection_status: "COLLECTED", collected_at: now, collected_by: staff })
        .eq("collection_token_hash", tokenHash).eq("payment_status", "PAID").eq("collection_status", "READY").select(), "redeem");
    },
    async rotateToken(orderId, newHash, now) {
      return one(await orders().update({ collection_token_hash: newHash, collection_token_issued_at: now, qr_email_status: "NOT_SENT", qr_email_sent: false })
        .eq("order_id", orderId).eq("payment_status", "PAID").eq("collection_status", "READY").select(), "rotate token");
    },
    async patch(orderId, fields) {
      const upd = {}; for (const [k, v] of Object.entries(fields)) if (PATCHABLE[k]) upd[PATCHABLE[k]] = v;
      const res = await orders().update(upd).eq("order_id", orderId).select();
      return one(res, "patch order");
    },
    async uploadProof(path, buf, mime) { const r = await sb.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: false }); if (r.error) fail(r.error, "upload proof"); },
    async removeProof(path) { await sb.storage.from(BUCKET).remove([path]); },
    async signedProofUrl(path, seconds) { const r = await sb.storage.from(BUCKET).createSignedUrl(path, seconds); if (r.error) fail(r.error, "sign url"); return r.data.signedUrl; },
  };
}
module.exports = { createStore, fromRow };
