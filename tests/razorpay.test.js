"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("crypto");
const { createApp } = require("../server");
const { createRazorpay } = require("../lib/razorpay");
const { fakeStore, fakeSheets, fakeMail } = require("./fakes");
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const TOK = "A".repeat(43), KEY_ID = "rzp_test_FAKEKEY12345", KEY_SECRET = "fake_key_secret_value_123", WH_SECRET = "fake_webhook_secret";
const ENV = { STAFF_TOKEN_HASHES: `Alice:${sha(TOK)}`, RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH_SECRET };

// Fake Razorpay REST API (the real lib/razorpay.js runs against it, including Basic auth and request shapes).
function fakeRazorpayFetch() {
  const f = { orders: new Map(), payments: new Map(), calls: [], failFetch: false, failCreate: false };
  f.fetch = async (url, opts) => {
    const path = url.replace("https://api.razorpay.com/v1", ""), method = opts.method; f.calls.push(method + " " + path);
    if (opts.headers.Authorization !== "Basic " + Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64")) return new Response('{"error":{"description":"auth"}}', { status: 401 });
    if (method === "POST" && path === "/orders") { if (f.failCreate) return new Response('{"error":{"description":"boom"}}', { status: 500 }); const b = JSON.parse(opts.body); const o = { id: "order_" + crypto.randomBytes(7).toString("hex"), amount: b.amount, currency: b.currency, receipt: b.receipt, status: "created" }; f.orders.set(o.id, o); return new Response(JSON.stringify(o)); }
    let m = /^\/payments\/(pay_\w+)$/.exec(path); if (method === "GET" && m) { if (f.failFetch) return new Response("{}", { status: 503 }); const p = f.payments.get(m[1]); return p ? new Response(JSON.stringify(p)) : new Response('{"error":{"description":"not found"}}', { status: 400 }); }
    m = /^\/payments\/(pay_\w+)\/capture$/.exec(path); if (method === "POST" && m) { const p = f.payments.get(m[1]); const b = JSON.parse(opts.body); if (!p || p.status !== "authorized" || b.amount !== p.amount) return new Response("{}", { status: 400 }); p.status = "captured"; return new Response(JSON.stringify(p)); }
    return new Response("{}", { status: 404 });
  };
  // test helper: Razorpay records a payment for one of its orders
  f.pay = (rzOrderId, { status = "captured", amount, currency = "INR", id } = {}) => { const o = f.orders.get(rzOrderId); const p = { id: id || "pay_" + crypto.randomBytes(7).toString("hex"), order_id: rzOrderId, amount: amount ?? o.amount, currency, status }; f.payments.set(p.id, p); return p; };
  return f;
}
async function boot(env = ENV) {
  const store = fakeStore(), sheets = fakeSheets(), mail = fakeMail(), rzApi = fakeRazorpayFetch();
  const razorpay = createRazorpay(env, rzApi.fetch);
  const app = createApp({ store, sheets, mail, razorpay, env });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
  return { store, sheets, mail, rzApi, call, close: () => { server.closeAllConnections(); server.close(); } };
}
const cart = (o = {}) => ({ name: "Test Student", email: "test.student@iitdh.ac.in", rollNo: "TEST001", phone: "9999999999", batchYear: "2026 BTech", couponCode: "", items: [{ name: "Classic T-Shirt", quantity: 1, size: "M", color: "Black", customName: "N/A" }], ...o });
async function start(t, o) { const r = await t.call("POST", "/api/razorpay/create-order", cart(o)); assert.equal(r.status, 201, r.text); return r.json; }
const verifyBody = (c, pay, secret = KEY_SECRET) => ({ orderId: c.orderId, razorpay_order_id: c.razorpayOrderId, razorpay_payment_id: pay.id, razorpay_signature: hmac(secret, c.razorpayOrderId + "|" + pay.id) });
const webhook = (t, evt, secret = WH_SECRET) => { const raw = JSON.stringify(evt); return t.call("POST", "/api/razorpay/webhook", raw, { "x-razorpay-signature": hmac(secret, raw) }); };
const capturedEvt = pay => ({ event: "payment.captured", payload: { payment: { entity: pay } } });

test("create-order: server computes the amount (₹1/item, in paise); browser prices ignored; order is AWAITING_PAYMENT; nothing emailed or put in the sheet yet", async () => { const t = await boot();
  const c = await start(t, { total: 999, amount: 1, items: [{ name: "Classic T-Shirt", quantity: 3, size: "M", color: "Black", price: 5000 }, { name: "CS Hoodie", quantity: 2, size: "L", color: "Black", unitPrice: 9999 }] });
  assert.equal(c.amountPaise, 500); assert.equal(c.currency, "INR"); assert.equal(t.rzApi.orders.get(c.razorpayOrderId).amount, 500); assert.equal(t.rzApi.orders.get(c.razorpayOrderId).receipt, c.orderId);
  const o = t.store.orders.get(c.orderId); assert.equal(o.paymentStatus, "AWAITING_PAYMENT"); assert.equal(o.paymentMethod, "RAZORPAY"); assert.equal(o.total, 5); assert.equal(o.collectionStatus, "NOT_READY"); assert.ok(!o.tokenHash);
  assert.equal(t.mail.qrs.length + t.mail.acks.length, 0); assert.equal(t.sheets.rows.size, 0);
  assert.equal(c.keyId, KEY_ID); const raw = JSON.stringify(c); assert.ok(!raw.includes(KEY_SECRET) && !raw.includes(WH_SECRET)); t.close(); });

test("create-order rejects bad student fields, unknown products, bad quantities and coupons (nothing is created at Razorpay or in the DB)", async () => { const t = await boot();
  for (const bad of [{ email: "a@gmail.com" }, { phone: "123" }, { name: "" }, { couponCode: "SAVE50" }, { items: [] }, { items: [{ name: "Gold Watch", quantity: 1, size: "M", color: "Black" }] }, { items: [{ name: "Classic T-Shirt", quantity: 0, size: "M", color: "Black" }] }])
    assert.equal((await t.call("POST", "/api/razorpay/create-order", cart(bad))).status, 400, JSON.stringify(bad));
  assert.equal(t.rzApi.orders.size, 0); assert.equal(t.store.orders.size, 0); t.close(); });

test("create-order is unavailable (503) when Razorpay keys are not configured; Razorpay outage returns a safe 502 and stores nothing", async () => {
  const t = await boot({ ...ENV, RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" }); assert.equal((await t.call("POST", "/api/razorpay/create-order", cart())).status, 503);
  assert.equal((await t.call("GET", "/api/health")).json.razorpayConfigured, false); t.close();
  const t2 = await boot(); t2.rzApi.failCreate = true; const r = await t2.call("POST", "/api/razorpay/create-order", cart()); assert.equal(r.status, 502); assert.ok(!/boom|rzp_|secret/i.test(r.text)); assert.equal(t2.store.orders.size, 0); t2.close(); });

test("verify: valid signature + captured payment of the exact amount => PAID, gateway-verified, collection READY, sheet row updated, QR emailed once, no token in response", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); const r = await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay));
  assert.equal(r.status, 200, r.text); assert.equal(r.json.paymentStatus, "PAID"); assert.equal(r.json.collectionQrEmailed, true);
  const o = t.store.orders.get(c.orderId); assert.equal(o.paymentStatus, "PAID"); assert.equal(o.verificationSource, "razorpay_verified"); assert.equal(o.verifiedBy, "Razorpay"); assert.equal(o.razorpayPaymentId, pay.id); assert.equal(o.collectionStatus, "READY");
  assert.equal(t.mail.qrs.length, 1); assert.equal(t.mail.qrs[0].to, "test.student@iitdh.ac.in"); assert.equal(t.sheets.rows.size, 1); const row = t.sheets.rows.get(c.orderId); assert.match(row[13], /PAID \(Razorpay verified\)/); assert.equal(row[14], "RAZORPAY"); assert.equal(row[15], pay.id);
  assert.ok(!r.text.includes(t.mail.qrs[0].token) && !r.text.includes(o.tokenHash)); t.close(); });

test("verify rejects forged or invalid proof: bad signature, wrong secret, tampered ids, unknown order; order stays AWAITING_PAYMENT", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); const ok = verifyBody(c, pay);
  for (const [name, body] of [["wrong secret", verifyBody(c, pay, "attacker_secret_xx")], ["no signature", { ...ok, razorpay_signature: "" }], ["garbage signature", { ...ok, razorpay_signature: "z".repeat(64) }], ["other payment id", { ...ok, razorpay_payment_id: "pay_OTHER1234567" }], ["bad id format", { ...ok, orderId: "x" }]]) { const r = await t.call("POST", "/api/razorpay/verify", body); assert.ok([400, 404].includes(r.status), name + " -> " + r.status); }
  const other = await start(t, { email: "other@iitdh.ac.in" }); const fakeOrderBody = verifyBody({ orderId: other.orderId, razorpayOrderId: c.razorpayOrderId }, pay);
  assert.equal((await t.call("POST", "/api/razorpay/verify", fakeOrderBody)).status, 404, "razorpay order id belonging to a different order");
  assert.equal(t.store.orders.get(c.orderId).paymentStatus, "AWAITING_PAYMENT"); assert.equal(t.store.orders.get(other.orderId).paymentStatus, "AWAITING_PAYMENT"); assert.equal(t.mail.qrs.length, 0); t.close(); });

test("verify trusts Razorpay's API, not the browser: amount mismatch, wrong currency, payment of another order, failed/created payment are all refused", async () => { const t = await boot();
  const c = await start(t, { items: [{ name: "Classic T-Shirt", quantity: 2, size: "M", color: "Black" }] }); const o2 = await start(t);
  const cases = [["underpaid", t.rzApi.pay(c.razorpayOrderId, { amount: 100 })], ["wrong currency", t.rzApi.pay(c.razorpayOrderId, { currency: "USD" })], ["other order's payment", t.rzApi.pay(o2.razorpayOrderId)], ["failed", t.rzApi.pay(c.razorpayOrderId, { status: "failed" })], ["created", t.rzApi.pay(c.razorpayOrderId, { status: "created" })]];
  for (const [name, pay] of cases) { const r = await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay)); assert.equal(r.status, 409, name + " -> " + r.status + r.text); }
  assert.equal(t.store.orders.get(c.orderId).paymentStatus, "AWAITING_PAYMENT"); assert.equal(t.mail.qrs.length, 0); assert.equal(t.sheets.rows.size, 0);
  const unknown = verifyBody(c, { id: "pay_DOESNOTEXIST1" }); assert.equal((await t.call("POST", "/api/razorpay/verify", unknown)).status, 502, "payment Razorpay does not know"); t.close(); });

test("an 'authorized' payment is captured by the server for the exact amount, then confirmed", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId, { status: "authorized" }); const r = await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay));
  assert.equal(r.status, 200, r.text); assert.ok(t.rzApi.calls.some(x => x.endsWith("/capture"))); assert.equal(t.store.orders.get(c.orderId).paymentStatus, "PAID"); t.close(); });

test("repeat verify, and concurrent verify + webhook, confirm exactly once and send exactly one QR", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); const body = verifyBody(c, pay);
  const rs = await Promise.all([t.call("POST", "/api/razorpay/verify", body), t.call("POST", "/api/razorpay/verify", body), webhook(t, capturedEvt(pay)), t.call("POST", "/api/razorpay/verify", body), webhook(t, capturedEvt(pay))]);
  assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join()); assert.equal(t.mail.qrs.length, 1, "one QR"); assert.equal(t.sheets.rows.size, 1);
  const again = await t.call("POST", "/api/razorpay/verify", body); assert.equal(again.json.alreadyConfirmed, true); assert.equal(t.mail.qrs.length, 1); t.close(); });

test("the same Razorpay payment cannot pay two different orders", async () => { const t = await boot();
  const a = await start(t), b = await start(t, { email: "b@iitdh.ac.in" }); const payA = t.rzApi.pay(a.razorpayOrderId);
  assert.equal((await t.call("POST", "/api/razorpay/verify", verifyBody(a, payA))).status, 200);
  const payB = t.rzApi.pay(b.razorpayOrderId, { id: payA.id }); // attacker reuses payment id on order B
  assert.notEqual((await t.call("POST", "/api/razorpay/verify", verifyBody(b, payB))).status, 200); assert.equal(t.store.orders.get(b.orderId).paymentStatus, "AWAITING_PAYMENT"); t.close(); });

test("webhook: valid signed payment.captured marks the order PAID even if the student closed the tab (once, one QR)", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); const r = await webhook(t, capturedEvt(pay));
  assert.equal(r.status, 200); assert.equal(t.store.orders.get(c.orderId).paymentStatus, "PAID"); assert.equal(t.mail.qrs.length, 1); await webhook(t, capturedEvt(pay)); assert.equal(t.mail.qrs.length, 1);
  const ev2 = { event: "order.paid", payload: { payment: { entity: pay } } }; assert.equal((await webhook(t, ev2)).status, 200); assert.equal(t.mail.qrs.length, 1); t.close(); });

test("webhook rejects missing/forged signatures; ignores unknown orders and other events; never trusts the payload amount", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId, { amount: 100 }); const evt = capturedEvt(pay);
  assert.equal((await t.call("POST", "/api/razorpay/webhook", JSON.stringify(evt))).status, 400, "no signature");
  assert.equal((await webhook(t, evt, "attacker")).status, 400, "forged signature"); assert.equal(t.store.orders.get(c.orderId).paymentStatus, "AWAITING_PAYMENT");
  const lying = { ...pay, amount: 100 }; t.rzApi.payments.get(pay.id).amount = 1; // Razorpay's API says ₹0.01 though the payload claims otherwise
  const o5 = await start(t, { items: [{ name: "Classic T-Shirt", quantity: 5, size: "M", color: "Black" }] }); const cheap = t.rzApi.pay(o5.razorpayOrderId, { amount: 100 });
  assert.equal((await webhook(t, capturedEvt({ ...cheap, amount: 500 }))).status, 200); assert.equal(t.store.orders.get(o5.orderId).paymentStatus, "AWAITING_PAYMENT", "payload amount ignored; API says underpaid");
  assert.equal((await webhook(t, capturedEvt({ id: "pay_UNKNOWN123456", order_id: "order_UNKNOWN12345", amount: 100, currency: "INR", status: "captured" }))).json.ignored, true);
  assert.equal((await webhook(t, { event: "payment.failed", payload: { payment: { entity: pay } } })).json.ignored, true); assert.equal(t.mail.qrs.length, 0);
  const noSecret = await boot({ ...ENV, RAZORPAY_WEBHOOK_SECRET: "" }); const raw = JSON.stringify(evt); assert.equal((await noSecret.call("POST", "/api/razorpay/webhook", raw, { "x-razorpay-signature": hmac("", raw) })).status, 400, "no webhook secret configured => always refuse"); noSecret.close(); t.close(); });

test("gateway-paid order can be collected exactly once by staff, using the QR emailed after payment", async () => { const t = await boot();
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay)); const token = t.mail.qrs[0].token; const auth = { authorization: "Bearer " + TOK };
  const awaiting = await start(t, { email: "later@iitdh.ac.in" }); assert.equal((await t.call("POST", "/api/collection/redeem", { token: "Z".repeat(43) }, auth)).status, 404, "unpaid orders have no valid QR");
  assert.equal((await t.call("POST", "/api/collection/redeem", { token }, auth)).status, 200); assert.equal((await t.call("POST", "/api/collection/redeem", { token }, auth)).status, 409);
  assert.match(t.sheets.rows.get(c.orderId)[17], /COLLECTED/); assert.equal(t.store.orders.get(awaiting.orderId).paymentStatus, "AWAITING_PAYMENT"); t.close(); });

test("sheet or email failure after a confirmed payment never un-pays the order; resend QR rotates the token", async () => { const t = await boot(); t.sheets.fail = true; t.mail.failQr = true;
  const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId); const r = await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay));
  assert.equal(r.status, 200); assert.equal(r.json.collectionQrEmailed, false); assert.equal(r.json.vendorSheetUpdated, false); const o = t.store.orders.get(c.orderId); assert.equal(o.paymentStatus, "PAID"); assert.equal(o.sheetSynced, false); assert.equal(o.qrEmailStatus, "FAILED");
  t.sheets.fail = false; t.mail.failQr = false; const auth = { authorization: "Bearer " + TOK };
  assert.equal((await t.call("POST", `/admin/orders/${c.orderId}/retry-sync`, {}, auth)).json.sheetUpdated, true); assert.equal((await t.call("POST", `/admin/orders/${c.orderId}/resend-qr`, {}, auth)).json.collectionQrEmailed, true); assert.equal(t.mail.qrs.length, 1); t.close(); });

test("Razorpay secrets never appear in responses or logs; health reports only booleans/mode", async () => { const logs = []; const orig = { e: console.error, l: console.log }; console.error = console.log = (...a) => logs.push(a.join(" "));
  try { const t = await boot(); t.rzApi.failFetch = true; const c = await start(t); const pay = t.rzApi.pay(c.razorpayOrderId);
    const rs = [await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay)), await t.call("POST", "/api/razorpay/verify", verifyBody(c, pay, "bad")), await t.call("GET", "/api/health"), await webhook(t, capturedEvt(pay)), await t.call("POST", "/api/razorpay/webhook", "x")];
    for (const r of rs) for (const s of [KEY_SECRET, WH_SECRET]) assert.ok(!r.text.includes(s)); const all = logs.join("\n"); for (const s of [KEY_SECRET, WH_SECRET, "test.student@iitdh.ac.in", "9999999999", "Test Student"]) assert.ok(!all.includes(s), "log leaked " + s.slice(0, 6));
    const h = (await t.call("GET", "/api/health")).json; assert.equal(h.razorpayConfigured, true); assert.equal(h.razorpayMode, "test"); assert.equal(h.razorpayWebhookConfigured, true); t.close(); } finally { Object.assign(console, { error: orig.e, log: orig.l }); } });

test("the real signature functions match independently computed HMACs and reject near-misses", () => { const rz = createRazorpay(ENV);
  const good = hmac(KEY_SECRET, "order_ABCDEF123|pay_ABCDEF123"); assert.equal(rz.verifyCheckoutSignature("order_ABCDEF123", "pay_ABCDEF123", good), true);
  assert.equal(rz.verifyCheckoutSignature("order_ABCDEF123", "pay_ABCDEF124", good), false); assert.equal(rz.verifyCheckoutSignature("order_ABCDEF123", "pay_ABCDEF123", good.toUpperCase()), true, "hex case-insensitive"); assert.equal(rz.verifyCheckoutSignature("order_ABCDEF123", "pay_ABCDEF123", good.slice(0, 63)), false);
  const body = Buffer.from('{"event":"x"}'); assert.equal(rz.verifyWebhookSignature(body, hmac(WH_SECRET, body)), true); assert.equal(rz.verifyWebhookSignature(Buffer.from('{"event":"y"}'), hmac(WH_SECRET, body)), false); assert.equal(rz.verifyWebhookSignature("string-not-buffer", hmac(WH_SECRET, body)), false); });

test("frontend: Razorpay Checkout is loaded from Razorpay, the browser sends no prices, and only the public key id is used", () => { const fs = require("fs"), path = require("path"); const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js/); assert.match(app, /\/api\/razorpay\/create-order/); assert.match(app, /\/api\/razorpay\/verify/);
  const m = /const rzPayload = \{([^}]*)\}/.exec(app); assert.ok(m, "razorpay payload shape"); assert.ok(!/price|total|amount/i.test(m[1]), "no price fields from the browser");
  assert.match(app, /razorpay_signature/); assert.ok(!/KEY_SECRET|rzp_(test|live)_/.test(app), "no secret or hard-coded key in the browser"); });
