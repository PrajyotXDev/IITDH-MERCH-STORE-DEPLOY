"use strict";
// In-memory stand-ins that follow the same contracts as lib/store.js, lib/sheets.js, lib/mail.js.
// Each store transition is synchronous (atomic) like the guarded single-statement UPDATEs in Postgres.
const { orderToRow } = require("../lib/sheets");
function fakeStore() {
  const orders = new Map(), proofs = new Map();
  const get = id => orders.get(id) || null, clone = o => (o ? JSON.parse(JSON.stringify(o)) : null);
  return {
    orders, proofs,
    async findDuplicates({ utr, hash }) { const all = [...orders.values()]; return { utr: all.some(o => o.upiReference && o.upiReference.toLowerCase() === utr.toLowerCase()), hash: all.some(o => o.screenshotHash === hash) }; },
    async insertAwaiting(o) { const r = { ...o, currency: "INR", paymentStatus: "AWAITING_PAYMENT", paymentMethod: "UPI", collectionStatus: "NOT_READY", sheetSynced: false, ackEmailStatus: "NOT_SENT", qrEmailStatus: "NOT_SENT", qrEmailSent: false }; orders.set(o.orderId, r); return clone(r); },
    async insertRazorpayAwaiting(o) { const r = { ...o, currency: "INR", paymentStatus: "AWAITING_PAYMENT", paymentMethod: "RAZORPAY", collectionStatus: "NOT_READY", sheetSynced: false, ackEmailStatus: "NOT_SENT", qrEmailStatus: "NOT_SENT", qrEmailSent: false }; orders.set(o.orderId, r); return clone(r); },
    async findByRazorpayOrderId(id) { return clone([...orders.values()].find(o => o.razorpayOrderId === id)); },
    async markPaidRazorpay(id, { razorpayOrderId, paymentId, tokenHash, now }) {
      const o = get(id); if (!o || o.paymentMethod !== "RAZORPAY" || o.razorpayOrderId !== razorpayOrderId || o.paymentStatus !== "AWAITING_PAYMENT") return null;
      if ([...orders.values()].some(x => x !== o && x.razorpayPaymentId === paymentId)) { const e = new Error("dup"); e.code = "DUPLICATE_PAYMENT"; throw e; }
      Object.assign(o, { paymentStatus: "PAID", paidAt: now, verifiedAt: now, verifiedBy: "Razorpay", verificationSource: "razorpay_verified", razorpayPaymentId: paymentId, collectionStatus: "READY", tokenHash, qrEmailStatus: "NOT_SENT", qrEmailSent: false }); return clone(o); },
    async submitEvidence(id, { utr, path, hash, submittedAt }) {
      const o = get(id); if (!o || o.paymentStatus !== "AWAITING_PAYMENT") return null;
      for (const x of orders.values()) { if (x !== o && x.upiReference && x.upiReference.toLowerCase() === utr.toLowerCase()) { const e = new Error("dup"); e.code = "DUPLICATE_UTR"; throw e; } if (x !== o && x.screenshotHash === hash) { const e = new Error("dup"); e.code = "DUPLICATE_SCREENSHOT"; throw e; } }
      Object.assign(o, { paymentStatus: "PENDING_REVIEW", upiReference: utr, screenshotPath: path, screenshotHash: hash, paymentSubmittedAt: submittedAt }); return clone(o);
    },
    async discardAwaiting(id) { const o = get(id); if (o && o.paymentStatus === "AWAITING_PAYMENT") orders.delete(id); },
    async getOrder(id) { return clone(get(id)); },
    async listOrders(status) { return [...orders.values()].filter(o => o.paymentStatus === status).map(clone); },
    async approve(id, { staff, tokenHash, now }) { const o = get(id); if (!o || o.paymentStatus !== "PENDING_REVIEW") return null; Object.assign(o, { paymentStatus: "PAID", paidAt: now, verifiedAt: now, verifiedBy: staff, verificationSource: "manual_bank_verified", collectionStatus: "READY", tokenHash, qrEmailStatus: "NOT_SENT", qrEmailSent: false }); return clone(o); },
    async reject(id, { staff, reason, now }) { const o = get(id); if (!o || o.paymentStatus !== "PENDING_REVIEW") return null; Object.assign(o, { paymentStatus: "REJECTED", rejectedAt: now, rejectedBy: staff, rejectReason: reason }); return clone(o); },
    async findByTokenHash(h) { return clone([...orders.values()].find(o => o.tokenHash === h)); },
    async redeem(h, { staff, now }) { const o = [...orders.values()].find(x => x.tokenHash === h); if (!o || o.paymentStatus !== "PAID" || o.collectionStatus !== "READY") return null; Object.assign(o, { collectionStatus: "COLLECTED", collectedAt: now, collectedBy: staff }); return clone(o); },
    async rotateToken(id, h) { const o = get(id); if (!o || o.paymentStatus !== "PAID" || o.collectionStatus !== "READY") return null; Object.assign(o, { tokenHash: h, qrEmailStatus: "NOT_SENT", qrEmailSent: false }); return clone(o); },
    async patch(id, f) { const o = get(id); if (o) Object.assign(o, f); return clone(o); },
    async uploadProof(p, buf, mime) { proofs.set(p, { buf, mime }); },
    async removeProof(p) { proofs.delete(p); },
    async signedProofUrl(p) { if (!proofs.has(p)) throw new Error("missing"); return "https://signed.example/" + encodeURIComponent(p) + "?token=temp"; },
  };
}
function fakeSheets() {
  const rows = new Map(); const s = { rows, fail: false, calls: 0, configured: true,
    async upsertOrder(o) { s.calls++; if (s.fail) throw new Error("Google API unavailable"); rows.set(o.orderId, orderToRow(o)); } };
  return s;
}
function fakeMail() {
  const m = { acks: [], qrs: [], failQr: false, failAck: false, configured: true,
    async sendAck(o) { if (m.failAck) throw new Error("SMTP down"); m.acks.push({ to: o.email, orderId: o.orderId, hasQr: false }); },
    async sendQr(o, token) { if (m.failQr) throw new Error("SMTP down"); m.qrs.push({ to: o.email, orderId: o.orderId, token }); } };
  return m;
}
const img = (kind, size = 4000) => {
  const head = kind === "jpeg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0]) : kind === "png" ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : kind === "webp" ? Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]) : Buffer.from("not an image at all ");
  const b = Buffer.alloc(size, 7); head.copy(b); return b;
};
let n = 0;
const dataUrl = (buf, mime = "jpeg") => `data:image/${mime};base64,${buf.toString("base64")}`;
const uniqueShot = (kind = "jpeg") => { const b = img(kind); b.writeUInt32BE(++n * 7919 + Date.now() % 1000, 20); return dataUrl(b, kind); };
module.exports = { fakeStore, fakeSheets, fakeMail, img, dataUrl, uniqueShot };
