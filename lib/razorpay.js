"use strict";
const crypto = require("crypto");
const API = "https://api.razorpay.com/v1";

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmacHex = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

// Minimal Razorpay REST client. Key SECRET and webhook secret never leave the server; only the (public) Key ID goes to the browser.
function createRazorpay(env, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const keyId = env.RAZORPAY_KEY_ID || "", secret = env.RAZORPAY_KEY_SECRET || "", webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || "";
  const configured = /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) && secret.length >= 10;
  async function call(method, path, body) {
    if (!configured) throw new Error("Razorpay is not configured");
    const res = await doFetch(API + path, { method, headers: { Authorization: "Basic " + Buffer.from(keyId + ":" + secret).toString("base64"), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const text = await res.text(); let json = {}; try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) { const e = new Error(`Razorpay HTTP ${res.status}${json.error && json.error.description ? ": " + String(json.error.description).slice(0, 120) : ""}`); e.status = res.status; throw e; }
    return json;
  }
  return {
    configured, keyId: configured ? keyId : null, mode: keyId.startsWith("rzp_live_") ? "live" : "test", webhookConfigured: webhookSecret.length >= 6,
    createOrder: ({ amountPaise, receipt, notes }) => call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt, notes }),
    fetchPayment: id => call("GET", "/payments/" + encodeURIComponent(id)),
    capturePayment: (id, amountPaise) => call("POST", `/payments/${encodeURIComponent(id)}/capture`, { amount: amountPaise, currency: "INR" }),
    // Checkout signature: HMAC_SHA256(key_secret, "<razorpay_order_id>|<razorpay_payment_id>")
    verifyCheckoutSignature: (orderId, paymentId, signature) => configured && /^[a-f0-9]{64}$/i.test(String(signature || "")) && safeEq(hmacHex(secret, orderId + "|" + paymentId), String(signature).toLowerCase()),
    // Webhook signature: HMAC_SHA256(webhook_secret, raw request body)
    verifyWebhookSignature: (rawBuf, signature) => webhookSecret.length >= 6 && Buffer.isBuffer(rawBuf) && /^[a-f0-9]{64}$/i.test(String(signature || "")) && safeEq(hmacHex(webhookSecret, rawBuf), String(signature).toLowerCase()),
  };
}
module.exports = { createRazorpay };
