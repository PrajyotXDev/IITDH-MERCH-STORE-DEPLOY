"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("crypto"), fs = require("fs"), path = require("path"), vm = require("vm");
const { createApp } = require("../server");
const { fakeStore, fakeSheets, fakeMail, img, dataUrl, uniqueShot } = require("./fakes");
const { PRODUCT_PRICES } = require("../lib/validate");
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const TOK_A = "A".repeat(43), TOK_B = "B".repeat(43);
const ENV = { STAFF_TOKEN_HASHES: `Alice:${sha(TOK_A)},Bob:${sha(TOK_B)}`, SUPABASE_URL: "x", SUPABASE_SECRET_KEY: "x" };

async function boot() {
  const store = fakeStore(), sheets = fakeSheets(), mail = fakeMail();
  const app = createApp({ store, sheets, mail, env: ENV });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => { const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
  return { store, sheets, mail, base, call, close: () => { server.closeAllConnections(); server.close(); } };
}
const good = (o = {}) => ({ name: "Test Student", email: "test.student@iitdh.ac.in", rollNo: "TEST001", phone: "9999999999", batchYear: "2026 BTech", couponCode: "", upiReference: "TESTUTR" + Math.random().toString(36).slice(2, 10).toUpperCase(), screenshot: uniqueShot(), items: [{ name: "Classic T-Shirt", quantity: 1, size: "M", color: "Black", customName: "N/A" }], ...o });
async function placeOrder(t, o) { const r = await t.call("POST", "/api/submit-upi-order", good(o)); assert.equal(r.status, 201, r.text); return r.json.orderId; }
const approveBody = (t, id) => { const o = t.store.orders.get(id); return { confirmBankVerified: true, confirmedUtr: o.upiReference, confirmedAmount: o.total }; };

test("invalid student fields are rejected", async () => { const t = await boot();
  for (const bad of [{ email: "a@gmail.com" }, { phone: "12345" }, { name: "" }, { rollNo: "  " }, { batchYear: 5 }, { name: "Bad\nName" }]) { const r = await t.call("POST", "/api/submit-upi-order", good(bad)); assert.equal(r.status, 400, JSON.stringify(bad)); }
  assert.equal(t.store.orders.size, 0); t.close(); });

test("invalid products and quantities are rejected", async () => { const t = await boot();
  const mk = it => good({ items: [{ name: "Classic T-Shirt", quantity: 1, size: "M", color: "Black", ...it }] });
  for (const it of [{ name: "Gold Watch" }, { name: "__proto__" }, { quantity: 0 }, { quantity: 21 }, { quantity: 1.5 }, { quantity: "abc" }, { size: "" }]) assert.equal((await t.call("POST", "/api/submit-upi-order", mk(it))).status, 400, JSON.stringify(it));
  assert.equal((await t.call("POST", "/api/submit-upi-order", good({ items: [] }))).status, 400); t.close(); });

test("client-supplied prices/totals cannot override the server total; test mode is exactly ₹1 per item", async () => { const t = await boot();
  const id = await placeOrder(t, { total: 999, subtotal: 999, amount: 0.01, items: [{ name: "Classic T-Shirt", quantity: 3, size: "M", color: "Black", price: 500, unitPrice: 500, lineTotal: 1 }, { name: "CS Hoodie", quantity: 2, size: "L", color: "Black", price: 2000 }] });
  const o = t.store.orders.get(id); assert.equal(o.total, 5); assert.equal(o.subtotal, 5); assert.ok(o.items.every(i => i.unitPrice === 1));
  assert.equal((await t.call("POST", "/api/submit-upi-order", good({ couponCode: "SAVE50" }))).status, 400); t.close(); });

test("missing UTR or screenshot is rejected", async () => { const t = await boot();
  assert.equal((await t.call("POST", "/api/submit-upi-order", good({ upiReference: "" }))).status, 400);
  assert.equal((await t.call("POST", "/api/submit-upi-order", good({ upiReference: "short" }))).status, 400);
  assert.equal((await t.call("POST", "/api/submit-upi-order", good({ screenshot: "" }))).status, 400);
  const b = good(); delete b.screenshot; assert.equal((await t.call("POST", "/api/submit-upi-order", b)).status, 400); t.close(); });

test("bad screenshots rejected: fake signature, mime mismatch, unsupported type, oversized, reused", async () => { const t = await boot();
  const post = shot => t.call("POST", "/api/submit-upi-order", good({ screenshot: shot }));
  assert.equal((await post(dataUrl(img("text"), "jpeg"))).status, 400, "text labelled jpeg");
  assert.equal((await post(dataUrl(img("png"), "jpeg"))).status, 400, "png bytes labelled jpeg");
  assert.equal((await post(dataUrl(img("jpeg"), "gif"))).status, 400, "gif not allowed");
  assert.equal((await post("data:text/html;base64,PGgxPmhpPC9oMT4=")).status, 400, "html");
  assert.equal((await post(dataUrl(img("jpeg", 20), "jpeg"))).status, 400, "tiny");
  assert.ok([400, 413].includes((await post(dataUrl(img("jpeg", 3 * 1024 * 1024 + 10), "jpeg"))).status), "oversized (>3MB) rejected by body limit or validator");
  const {parseScreenshot}=require("../lib/validate"); assert.throws(() => parseScreenshot(dataUrl(img("jpeg", 3 * 1024 * 1024 + 10), "jpeg")), /under 3 MB/, "validator rejects >3MB");
  const same = uniqueShot("png"); assert.equal((await post(same)).status, 201); assert.equal((await post(same)).status, 409, "reused screenshot"); t.close(); });

test("duplicate UTRs are rejected (case-insensitive) and leave no stray order", async () => { const t = await boot();
  await placeOrder(t, { upiReference: "UTRDUP12345678" }); const before = t.store.orders.size;
  const r = await t.call("POST", "/api/submit-upi-order", good({ upiReference: "utrdup12345678" })); assert.equal(r.status, 409); assert.equal(t.store.orders.size, before); t.close(); });

test("a submission is PENDING_REVIEW (never PAID), screenshot stored privately, ack email has no QR, sheet shows not-paid", async () => { const t = await boot();
  const r = await t.call("POST", "/api/submit-upi-order", good({ paymentStatus: "PAID", paid: true, verified: true, collectionStatus: "READY" }));
  assert.equal(r.status, 201); assert.equal(r.json.paymentStatus, "PENDING_REVIEW");
  const o = t.store.orders.get(r.json.orderId); assert.equal(o.paymentStatus, "PENDING_REVIEW"); assert.equal(o.collectionStatus, "NOT_READY"); assert.ok(!o.tokenHash);
  assert.ok(o.screenshotPath.startsWith("orders/" + o.orderId + "/")); assert.equal(t.store.proofs.size, 1);
  assert.equal(t.mail.qrs.length, 0, "no QR while pending"); assert.equal(t.mail.acks.length, 1);
  const row = t.sheets.rows.get(o.orderId); assert.match(row[13], /PENDING VERIFICATION/); assert.equal(row[16], "", "Paid At blank"); assert.doesNotMatch(row[13], /^PAID/); t.close(); });

test("students cannot reach staff routes; unauthorised/invalid tokens cannot list, view screenshots, approve, reject, or collect", async () => { const t = await boot();
  const id = await placeOrder(t); const bodyOk = approveBody(t, id);
  for (const tok of [undefined, "wrong".repeat(10), "C".repeat(43)]) {
    assert.equal((await t.call("GET", "/admin/orders", undefined, tok)).status, 401);
    assert.equal((await t.call("GET", `/admin/orders/${id}/screenshot-url`, undefined, tok)).status, 401);
    assert.equal((await t.call("POST", `/admin/orders/${id}/approve-upi`, bodyOk, tok)).status, 401);
    assert.equal((await t.call("POST", `/admin/orders/${id}/reject`, { reason: "nope" }, tok)).status, 401);
    assert.equal((await t.call("POST", "/api/collection/redeem", { token: "x".repeat(43) }, tok)).status, 401); }
  assert.equal(t.store.orders.get(id).paymentStatus, "PENDING_REVIEW"); t.close(); });

test("staff approval needs explicit bank confirmation with the exact UTR and amount", async () => { const t = await boot();
  const id = await placeOrder(t); const ok = approveBody(t, id); const url = `/admin/orders/${id}/approve-upi`;
  assert.equal((await t.call("POST", url, {}, TOK_A)).status, 400);
  assert.equal((await t.call("POST", url, { ...ok, confirmBankVerified: "true" }, TOK_A)).status, 400);
  assert.equal((await t.call("POST", url, { ...ok, confirmedUtr: "WRONGUTR12345" }, TOK_A)).status, 400);
  assert.equal((await t.call("POST", url, { ...ok, confirmedAmount: 0.5 }, TOK_A)).status, 400);
  assert.equal((await t.call("POST", url, { ...ok, confirmedAmount: "abc" }, TOK_A)).status, 400);
  assert.equal(t.store.orders.get(id).paymentStatus, "PENDING_REVIEW"); assert.equal(t.mail.qrs.length, 0); t.close(); });

test("valid approval: PAID + verifier recorded, sheet row updated in place (no duplicate), QR emailed once, no token in response", async () => { const t = await boot();
  const id = await placeOrder(t); const r = await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A);
  assert.equal(r.status, 200, r.text); const o = t.store.orders.get(id);
  assert.equal(o.paymentStatus, "PAID"); assert.equal(o.verifiedBy, "Alice"); assert.equal(o.verificationSource, "manual_bank_verified"); assert.ok(o.verifiedAt); assert.equal(o.collectionStatus, "READY");
  assert.equal(t.mail.qrs.length, 1); assert.equal(t.mail.qrs[0].to, "test.student@iitdh.ac.in"); assert.equal(t.sheets.rows.size, 1);
  assert.match(t.sheets.rows.get(id)[13], /PAID \(bank verified\)/); assert.equal(o.qrEmailStatus, "SENT");
  assert.ok(!r.text.includes(t.mail.qrs[0].token) && !r.text.includes(o.tokenHash), "no token in response");
  const again = await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_B); assert.equal(again.status, 200); assert.equal(again.json.alreadyApproved, true); assert.equal(t.mail.qrs.length, 1, "repeat approval sends nothing"); t.close(); });

test("concurrent approvals by two staff approve exactly once and email exactly one QR", async () => { const t = await boot();
  const id = await placeOrder(t); const b = approveBody(t, id);
  const rs = await Promise.all([t.call("POST", `/admin/orders/${id}/approve-upi`, b, TOK_A), t.call("POST", `/admin/orders/${id}/approve-upi`, b, TOK_B), t.call("POST", `/admin/orders/${id}/approve-upi`, b, TOK_A)]);
  assert.equal(t.mail.qrs.length, 1); assert.equal(rs.filter(r => r.status === 200 && !r.json.alreadyApproved).length, 1); assert.ok(rs.every(r => [200, 409].includes(r.status))); t.close(); });

test("Google Sheets failure never loses the order or screenshot; retry upserts the same row", async () => { const t = await boot(); t.sheets.fail = true;
  const id = await placeOrder(t); let o = t.store.orders.get(id);
  assert.equal(o.paymentStatus, "PENDING_REVIEW"); assert.equal(t.store.proofs.size, 1); assert.equal(o.sheetSynced, false); assert.match(o.sheetSyncError, /Google API/);
  t.sheets.fail = false; const r = await t.call("POST", `/admin/orders/${id}/retry-sync`, {}, TOK_A); assert.equal(r.json.sheetUpdated, true);
  o = t.store.orders.get(id); assert.equal(o.sheetSynced, true); assert.equal(o.sheetSyncError, null);
  await t.call("POST", `/admin/orders/${id}/retry-sync`, {}, TOK_A); assert.equal(t.sheets.rows.size, 1, "no duplicate rows"); t.close(); });

test("email failure is recorded, and Resend QR issues a fresh token (old one dies) without duplicating valid tokens", async () => { const t = await boot(); t.mail.failQr = true;
  const id = await placeOrder(t); const r = await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A);
  assert.equal(r.status, 200); assert.equal(r.json.collectionQrEmailed, false); assert.equal(t.store.orders.get(id).qrEmailStatus, "FAILED"); assert.equal(t.store.orders.get(id).paymentStatus, "PAID");
  t.mail.failQr = false; const oldHash = t.store.orders.get(id).tokenHash;
  const rs = await t.call("POST", `/admin/orders/${id}/resend-qr`, {}, TOK_A); assert.equal(rs.json.collectionQrEmailed, true); assert.equal(t.mail.qrs.length, 1);
  const newToken = t.mail.qrs[0].token; assert.notEqual(t.store.orders.get(id).tokenHash, oldHash); assert.equal(t.store.orders.get(id).qrEmailStatus, "SENT");
  assert.equal((await t.call("POST", `/admin/orders/${id}/resend-qr`, {}, TOK_A)).status, 409, "already sent needs explicit resend");
  assert.equal((await t.call("POST", "/api/collection/redeem", { token: newToken }, TOK_A)).status, 200); t.close(); });

test("pending, rejected and unknown orders cannot be collected; rejected cannot be approved; ack-email failure is non-fatal", async () => { const t = await boot(); t.mail.failAck = true;
  const id = await placeOrder(t); assert.equal(t.store.orders.get(id).ackEmailStatus, "FAILED"); assert.equal(t.store.orders.get(id).paymentStatus, "PENDING_REVIEW");
  assert.equal((await t.call("POST", "/api/collection/redeem", { token: "Z".repeat(43) }, TOK_A)).status, 404);
  assert.equal((await t.call("POST", `/admin/orders/${id}/reject`, { reason: "x" }, TOK_A)).status, 400);
  assert.equal((await t.call("POST", `/admin/orders/${id}/reject`, { reason: "No bank credit found" }, TOK_A)).status, 200);
  assert.equal(t.store.orders.get(id).paymentStatus, "REJECTED"); assert.match(t.sheets.rows.get(id)[13], /REJECTED/);
  assert.equal((await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A)).status, 409); assert.equal(t.mail.qrs.length, 0); t.close(); });

test("a verified order is collected exactly once; second scan is a clear conflict; sheet row updated", async () => { const t = await boot();
  const id = await placeOrder(t); await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A); const token = t.mail.qrs[0].token;
  const look = await t.call("POST", "/api/collection/lookup", { token: "IITDH-MERCH-COLLECTION:" + token }, TOK_B); assert.equal(look.status, 200); assert.equal(look.json.order.collectionStatus, "READY"); assert.ok(!look.text.includes(token));
  const r1 = await t.call("POST", "/api/collection/redeem", { token: "IITDH-MERCH-COLLECTION:" + token }, TOK_B); assert.equal(r1.status, 200); assert.equal(r1.json.collectedBy, "Bob");
  const r2 = await t.call("POST", "/api/collection/redeem", { token }, TOK_A); assert.equal(r2.status, 409); assert.equal(r2.json.code, "ALREADY_COLLECTED"); assert.match(r2.json.error, /Already collected/);
  const o = t.store.orders.get(id); assert.equal(o.collectionStatus, "COLLECTED"); assert.equal(o.collectedBy, "Bob"); assert.match(t.sheets.rows.get(id)[17], /COLLECTED/); assert.ok(t.sheets.rows.get(id)[18]); t.close(); });

test("concurrent redeem attempts: exactly one succeeds", async () => { const t = await boot();
  const id = await placeOrder(t); await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A); const token = t.mail.qrs[0].token;
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => t.call("POST", "/api/collection/redeem", { token }, i % 2 ? TOK_A : TOK_B)));
  assert.equal(rs.filter(r => r.status === 200).length, 1); assert.equal(rs.filter(r => r.status === 409).length, 11); t.close(); });

test("raw collection tokens, hashes and screenshot hashes never appear in admin responses; logs contain no PII/tokens/secrets", async () => { const logs = []; const orig = { e: console.error, l: console.log, w: console.warn };
  console.error = console.log = console.warn = (...a) => logs.push(a.join(" "));
  try { const t = await boot(); t.sheets.fail = true; t.mail.failAck = true; t.mail.failQr = true;
    const body = good({ name: "Secret Person", email: "secret.person@iitdh.ac.in" }); const sub = await t.call("POST", "/api/submit-upi-order", body); const id = sub.json.orderId;
    const ap = await t.call("POST", `/admin/orders/${id}/approve-upi`, approveBody(t, id), TOK_A); const o = t.store.orders.get(id);
    const list = await t.call("GET", "/admin/orders?status=PAID", undefined, TOK_A); const view = await t.call("POST", "/api/collection/lookup", { token: "Q".repeat(43) }, TOK_A);
    for (const r of [sub, ap, list, view]) for (const secret of [o.tokenHash, o.screenshotHash, TOK_A, sha(TOK_A)]) assert.ok(!r.text.includes(secret));
    assert.ok(!/tokenHash|collectionToken|screenshotHash|sha256/i.test(list.text));
    const all = logs.join("\n"); for (const s of ["Secret Person", "secret.person@iitdh.ac.in", body.upiReference, o.tokenHash, TOK_A, "9999999999"]) assert.ok(!all.includes(s), "log leaked: " + s.slice(0, 6)); t.close(); }
  finally { Object.assign(console, { error: orig.e, log: orig.l, warn: orig.w }); } });

test("repeated requests across separate app instances (cold starts) keep persisted orders", async () => { const store = fakeStore(), sheets = fakeSheets(), mail = fakeMail();
  const mk = () => createApp({ store, sheets, mail, env: ENV }); const s1 = await new Promise(r => { const s = mk().listen(0, () => r(s)); }); const b1 = `http://127.0.0.1:${s1.address().port}`;
  const r = await (await fetch(b1 + "/api/submit-upi-order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good()) })).json(); s1.closeAllConnections(); s1.close();
  const s2 = await new Promise(rs => { const s = mk().listen(0, () => rs(s)); }); const b2 = `http://127.0.0.1:${s2.address().port}`;
  const list = await (await fetch(b2 + "/admin/orders", { headers: { authorization: "Bearer " + TOK_A } })).json(); s2.closeAllConnections(); s2.close();
  assert.equal(list.orders.length, 1); assert.equal(list.orders[0].orderId, r.orderId); });

test("health endpoint reports configuration booleans only (no secrets)", async () => { const t = await boot(); const r = await t.call("GET", "/api/health");
  assert.equal(r.json.ok, true); assert.equal(r.json.testMode, true); assert.equal(r.json.unitPriceInr, 1); assert.ok(!r.text.includes(TOK_A)); assert.ok(!/key|secret|hash/i.test(Object.keys(r.json).join())); t.close(); });

test("frontend checkout field names match backend validation; frontend config is ₹1 test mode matching server prices", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const m = /const payload = \{ name, email, rollNo, phone, batchYear, couponCode: appliedCoupon, upiReference, screenshot, items: cart\.map\(item => \(\{ ([^}]*) \}\)\) \}/.exec(app); assert.ok(m, "order payload shape found in public/app.js");
  const itemKeys = [...m[1].matchAll(/(\w+):/g)].map(x => x[1]).sort(); assert.deepEqual(itemKeys, ["color", "customName", "name", "quantity", "size"]);
  assert.ok(!/unitPrice|lineTotal|total:|price:/.test(m[0]), "client never sends prices");
  assert.match(app, /fetch\([^)]*submit-upi-order/);
  const ctx = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/config.js"), "utf8") + ";this.C=STORE_CONFIG;", ctx); const C = ctx.C;
  assert.equal(C.coupons.length, 0); assert.equal(C.customNameFee, 0); assert.equal(C.xxlFee, 0);
  for (const p of C.products) { assert.equal(p.price, 1); assert.equal(PRODUCT_PRICES[p.name], 1, p.name + " known to server"); }
  assert.deepEqual(Object.keys(PRODUCT_PRICES).sort(), Array.from(C.products, p => p.name).sort()); });

test("no Razorpay SDK dependency; no secret-like text in tracked server files; secrets never referenced by browser files", () => {
  const pkg = fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"); assert.ok(!/"razorpay"\s*:/i.test(pkg), "plain REST client, no SDK");
  const files = ["server.js", ...fs.readdirSync(path.join(__dirname, "../lib")).map(f => "lib/" + f), ".env.example", "vercel.json"];
  for (const f of files) { const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); assert.ok(!/sb_secret_[A-Za-z0-9]{10,}|BEGIN [A-Z ]*PRIVATE KEY|eyJhbGciOi|rzp_(live|test)_[A-Za-z0-9]{8,}/.test(s), "secret-like text in " + f); }
  for (const f of fs.readdirSync(path.join(__dirname, "../public")).filter(f => /\.(js|html)$/.test(f))) { const s = fs.readFileSync(path.join(__dirname, "../public", f), "utf8"); assert.ok(!/KEY_SECRET|WEBHOOK_SECRET|SUPABASE_SECRET/.test(s), "server secret name referenced in public/" + f); } });
