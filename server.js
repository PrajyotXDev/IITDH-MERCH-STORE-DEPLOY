require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { google } = require("googleapis");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : (process.env.VERCEL ? path.join("/tmp", "iitdh-merch-store-data") : path.join(ROOT, "data"));
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const VISITS_FILE = path.join(DATA_DIR, "visits.json");
const SHOT_DIR = path.join(DATA_DIR, "screenshots");
// Create the parent data directory before its screenshots subdirectory.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
for (const file of [ORDERS_FILE, VISITS_FILE]) if (!fs.existsSync(file)) fs.writeFileSync(file, "[]", "utf8");
app.disable("x-powered-by");
// A 3 MB image expands to about 4 MB when base64-encoded; allow JSON overhead too.
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  if (/^\/(?:data|node_modules|\.git)(?:\/|$)/i.test(req.path) || /^\/(?:server\.js|package(?:-lock)?\.json|\.env(?:\.example)?|apps-script\.gs)$/i.test(req.path)) return res.status(404).send("Not found");
  next();
});
// On Vercel, explicitly serve the storefront from public/ as well as local root assets.
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"], dotfiles: "ignore" }));
app.use(express.static(ROOT, { extensions: ["html"], dotfiles: "ignore" }));

const PRODUCT_PRICES = { "Classic T-Shirt": 1, "Polo T-Shirt": 1, "Zipper Hoodie": 1, "CS Hoodie": 1, "EE Hoodie": 1 };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
function writeJson(file, data) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8"); fs.renameSync(tmp, file); }
function cleanText(v, label, max = 200) { if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new Error("Please check the " + label + " field."); return v.trim(); }
function sheetClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) return null;
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth });
}
async function appendOrderToSheet(order) {
  const sheets = sheetClient();
  if (!sheets) throw new Error("Google Sheets is not configured. Add service account credentials and spreadsheet ID to .env.");
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const itemsText = order.items.map(i => `${i.name} / ${i.color} / ${i.size} / qty ${i.quantity}${i.customName && i.customName !== "N/A" ? ` / print ${i.customName}` : ""}`).join("; ");
  const row = [order.orderId, order.createdAt, order.name, order.email, order.rollNo, order.phone, order.batchYear, itemsText, order.subtotal, order.discount, order.couponCode || "", order.total, order.currency || "INR", (order.verificationSource === "self_reported" ? "PAID (self-reported)" : order.paymentStatus), order.paymentMethod || "UPI", order.upiReference || "", order.paidAt || "", order.collectionStatus || "NOT_COLLECTED", order.collectedAt || "", order.screenshotFile || ""];
  await sheets.spreadsheets.values.append({ spreadsheetId, range: `${process.env.GOOGLE_SHEETS_TAB || "Orders"}!A:T`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] } });
  order.sheetSynced = true; order.sheetSyncedAt = new Date().toISOString();
  writeJson(ORDERS_FILE, replaceOrder(readJson(ORDERS_FILE), order));
}
function replaceOrder(orders, order) { const i = orders.findIndex(o => o.orderId === order.orderId); if (i < 0) orders.push(order); else orders[i] = order; return orders; }
function mailTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: String(SMTP_SECURE || "").toLowerCase() === "true" || Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
}
async function sendPaidOrderEmail(order, qrBuffer) {
  const transport = mailTransport(); if (!transport) return false;
  const itemLines = order.items.map((i, n) => `${n + 1}. ${i.name} | ${i.color} | Size ${i.size} | Qty ${i.quantity} | ₹${i.lineTotal}`).join("\n");
  const body = [`Hi ${order.name},`, "", "Your IIT Dharwad Merch Store order has been recorded.", `Order ID: ${order.orderId}`, `UPI reference: ${order.upiReference || "Verified manually"}`, `Amount paid: ₹${order.total}`, "", "ITEMS", itemLines, "", "Your unique merchandise collection QR is attached. Present it at the collection counter. It can be redeemed only once.", "Keep the QR private; anyone holding it may attempt to claim this order.", "", "IIT Dharwad Merch Store"].join("\n");
  await transport.sendMail({ from: `"IIT DH Merch Store" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`, to: order.email, subject: `Order confirmed — merch collection QR ${order.orderId}`, text: body, attachments: [{ filename: `${order.orderId}-collection-qr.png`, content: qrBuffer, contentType: "image/png", cid: "collectionqr" }] });
  return true;
}
async function syncPaidOrder(order) {
  if (order.paymentStatus !== "PAID") return;
  if (!order.sheetSynced) { try { await appendOrderToSheet(order); } catch (e) { console.error("Sheet sync failed (retry later):", e.message); } }
  if (!order.collectionTokenHash) {
    const token = crypto.randomBytes(32).toString("base64url");
    order.collectionTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    order.collectionToken = token; // private bearer token; never expose in admin APIs
    writeJson(ORDERS_FILE, replaceOrder(readJson(ORDERS_FILE), order));
  }
  if (!order.qrEmailSent) {
    try {
      const token = order.collectionToken;
      const qrBuffer = await QRCode.toBuffer(`IITDH-MERCH-COLLECTION:${token}`, { type: "png", errorCorrectionLevel: "H", margin: 2, width: 420 });
      const sent = await sendPaidOrderEmail(order, qrBuffer);
      order.qrEmailSent = sent;
      order.qrEmailStatus = sent ? "SENT" : "SMTP_NOT_CONFIGURED";
    } catch (e) { order.qrEmailStatus = "FAILED"; order.qrEmailError = e.message; console.error("Paid email failed:", e.message); }
    writeJson(ORDERS_FILE, replaceOrder(readJson(ORDERS_FILE), order));
  }
}
function calculateOrder(payload) {
  const name = cleanText(payload.name, "name", 120);
  const email = cleanText(payload.email, "email", 254).toLowerCase();
  const rollNo = cleanText(payload.rollNo, "roll number", 80);
  const phone = cleanText(payload.phone, "phone", 10);
  const batchYear = cleanText(payload.batchYear, "batch/program", 120);
  if (!/^[^@\s]+@iitdh\.ac\.in$/.test(email)) throw new Error("Please use your @iitdh.ac.in institute email.");
  if (!/^\d{10}$/.test(phone)) throw new Error("Phone number must contain exactly 10 digits.");
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 50) throw new Error("Invalid order items.");
  const items = payload.items.map(raw => {
    const itemName = cleanText(raw.name, "product", 120);
    const base = PRODUCT_PRICES[itemName];
    if (base === undefined) throw new Error("Unknown product: " + itemName);
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("Invalid item quantity.");
    const color = cleanText(raw.color, "color", 40);
    const size = cleanText(raw.size, "size", 20);
    const customName = String(raw.customName || "N/A").slice(0, 80);
    const unitPrice = base; // Deployment test mode: every item is exactly ₹1, regardless of options.
    return { name: itemName, color, size, quantity, customName, unitPrice, lineTotal: unitPrice * quantity };
  });
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const couponCode = String(payload.couponCode || "").trim().toUpperCase();
  let discount = 0;
  if (couponCode) throw new Error("Coupons are disabled in ₹1 test mode. Clear the coupon field and try again.");
  const total = Math.round((subtotal - discount) * 100) / 100;
  if (total <= 0) throw new Error("Invalid order total.");
  return { name, email, rollNo, phone, batchYear, items, subtotal, discount, total, couponCode };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "IIT DH Merch Store API", manualUpiEnabled: true, sheetsConfigured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && process.env.GOOGLE_SHEETS_SPREADSHEET_ID) }));
app.get("/api/catalogue", (_req, res) => res.json({ products: [] }));
app.post("/api/submit", (req, res) => {
  if (req.body?.type !== "visit") return res.status(400).json({ ok: false, error: "Unsupported submission type." });
  const visits = readJson(VISITS_FILE); visits.push({ receivedAt: new Date().toISOString(), visitorId: String(req.body.visitorId || "").slice(0, 120), page: String(req.body.page || "").slice(0, 500), referrer: String(req.body.referrer || "").slice(0, 500), screen: String(req.body.screen || "").slice(0, 80), language: String(req.body.language || "").slice(0, 80) }); writeJson(VISITS_FILE, visits); return res.json({ ok: true });
});
function saveScreenshot(dataUrl, orderId, orders) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new Error("Upload the payment screenshot as a JPG, PNG or WebP image.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 2000 || buf.length > 3 * 1024 * 1024) throw new Error("Screenshot must be a real image under 3 MB.");
  const ok = (m[1] === "jpeg" && buf[0] === 0xFF && buf[1] === 0xD8) || (m[1] === "png" && buf.slice(1, 4).toString() === "PNG") || (m[1] === "webp" && buf.slice(0, 4).toString() === "RIFF");
  if (!ok) throw new Error("The uploaded file is not a valid image.");
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  if (orders.some(o => o.screenshotHash === hash)) throw new Error("This screenshot has already been submitted for another order.");
  const file = orderId + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  fs.writeFileSync(path.join(SHOT_DIR, file), buf);
  return { file, hash };
}
app.post("/api/submit-upi-order", async (req, res) => {
  try {
    const details = calculateOrder(req.body || {});
    const upiReference = cleanText(req.body?.upiReference, "UPI transaction reference", 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(upiReference)) throw new Error("Enter a valid UPI UTR/reference (8–80 letters or digits).");
    const orders = readJson(ORDERS_FILE);
    if (orders.some(o => String(o.upiReference || "").toLowerCase() === upiReference.toLowerCase())) return res.status(409).json({ ok: false, error: "This UPI reference has already been submitted." });
    const orderId = "IITDH-" + new Date().toISOString().slice(0,10).replace(/-/g, "") + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const shot = saveScreenshot(req.body?.screenshot, orderId, orders);
    const order = { ...details, orderId, screenshotFile: shot.file, screenshotHash: shot.hash, createdAt: new Date().toISOString(), currency: "INR", paymentStatus: "PAID", paymentMethod: "UPI", upiReference, paidAt: new Date().toISOString(), verificationSource: "self_reported", collectionStatus: "NOT_COLLECTED", sheetSynced: false, qrEmailStatus: "NOT_ISSUED" };
    orders.push(order); writeJson(ORDERS_FILE, orders);
    await syncPaidOrder(order); // saves to sheet, creates collection QR, emails it (errors are logged, never lost)
    res.status(201).json({ ok: true, orderId, paymentStatus: order.paymentStatus, collectionQrEmailed: order.qrEmailSent === true, message: "Order placed." });
  } catch (e) { console.error("UPI order submission failed:", e.message); res.status(400).json({ ok: false, error: e.message || "Could not submit the order." }); }
});
async function updateSheetPaymentStatus(order) {
  const sheets = sheetClient(); if (!sheets) return;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID; const tab = process.env.GOOGLE_SHEETS_TAB || "Orders";
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:S` });
  const rows = result.data.values || []; const idx = rows.findIndex((r, i) => i > 0 && r[0] === order.orderId);
  if (idx >= 0) await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tab}!N${idx + 1}:Q${idx + 1}`, valueInputOption: "RAW", requestBody: { values: [[order.paymentStatus, order.paymentMethod || "UPI", order.upiReference || "", order.paidAt || ""]] } });
}

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get("x-admin-token") !== token) return res.status(401).json({ ok: false, error: "Staff authentication failed. Check ADMIN_TOKEN." });
  next();
}
function parseQrToken(raw) {
  const value = String(raw || "").trim();
  return value.startsWith("IITDH-MERCH-COLLECTION:") ? value.slice("IITDH-MERCH-COLLECTION:".length) : value;
}
app.post("/api/collection/lookup", requireAdmin, (req, res) => {
  const token = parseQrToken(req.body?.token);
  if (!token || token.length < 30) return res.status(400).json({ ok: false, error: "Invalid collection QR." });
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const order = readJson(ORDERS_FILE).find(o => o.collectionTokenHash && crypto.timingSafeEqual(Buffer.from(o.collectionTokenHash), Buffer.from(hash)));
  if (!order) return res.status(404).json({ ok: false, error: "QR not recognised." });
  res.json({ ok: true, order: { orderId: order.orderId, name: order.name, email: order.email, rollNo: order.rollNo, phone: order.phone, batchYear: order.batchYear, items: order.items, total: order.total, paymentStatus: order.paymentStatus, collectionStatus: order.collectionStatus, collectedAt: order.collectedAt || null } });
});
app.post("/api/collection/redeem", requireAdmin, async (req, res) => {
  try {
    const token = parseQrToken(req.body?.token);
    if (req.body?.confirmBankVerified !== true) return res.status(400).json({ ok: false, error: "Staff must confirm the UTR and credited amount were checked in the receiving bank/UPI account." });
    if (!token || token.length < 30) return res.status(400).json({ ok: false, error: "Invalid collection QR." });
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const orders = readJson(ORDERS_FILE);
    const order = orders.find(o => o.collectionTokenHash && crypto.timingSafeEqual(Buffer.from(o.collectionTokenHash), Buffer.from(hash)));
    if (!order) return res.status(404).json({ ok: false, error: "QR not recognised." });
    if (order.paymentStatus !== "PAID") return res.status(409).json({ ok: false, error: "Payment is not verified. Do not hand over merchandise." });
    if (order.collectionStatus === "COLLECTED") return res.status(409).json({ ok: false, error: `Already collected on ${order.collectedAt || "an earlier date"}. Do not issue this order again.`, orderId: order.orderId });
    order.collectionStatus = "COLLECTED"; order.collectedAt = new Date().toISOString(); order.collectedBy = String(req.body?.staffName || "Staff").slice(0, 100);
    writeJson(ORDERS_FILE, replaceOrder(orders, order));
    if (order.sheetSynced) await updateSheetCollectionStatus(order);
    res.json({ ok: true, orderId: order.orderId, collectionStatus: order.collectionStatus, collectedAt: order.collectedAt, message: "Collection recorded. This QR cannot be used again." });
  } catch (e) { console.error("Redeem error:", e.message); res.status(500).json({ ok: false, error: e.message || "Could not record collection." }); }
});
async function updateSheetCollectionStatus(order) {
  const sheets = sheetClient(); if (!sheets) return;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID; const tab = process.env.GOOGLE_SHEETS_TAB || "Orders";
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:S` });
  const rows = result.data.values || []; const idx = rows.findIndex((r, i) => i > 0 && r[0] === order.orderId);
  if (idx >= 0) await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tab}!R${idx + 1}:S${idx + 1}`, valueInputOption: "RAW", requestBody: { values: [[order.collectionStatus, order.collectedAt || ""]] } });
}
app.get("/admin/orders", requireAdmin, (_req, res) => {
  const orders = readJson(ORDERS_FILE).map(({ collectionTokenHash, collectionToken, collectionTokenEncryptedForEmail, screenshotHash, ...order }) => order);
  res.json({ ok: true, orders });
});
app.get("/admin/orders/:orderId/screenshot", requireAdmin, (req, res) => {
  const o = readJson(ORDERS_FILE).find(x => x.orderId === req.params.orderId);
  if (!o || !o.screenshotFile || !/^[A-Za-z0-9._-]+$/.test(o.screenshotFile)) return res.status(404).json({ ok: false, error: "No screenshot." });
  res.sendFile(path.join(SHOT_DIR, o.screenshotFile));
});
app.post("/admin/orders/:orderId/approve-upi", requireAdmin, async (req, res) => {
  try {
    const orders = readJson(ORDERS_FILE); const order = orders.find(o => o.orderId === req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found." });
    if (order.paymentStatus === "PAID") return res.json({ ok: true, orderId: order.orderId, paymentStatus: "PAID", message: "Order was already approved." });
    if (order.paymentStatus !== "PENDING_REVIEW") return res.status(409).json({ ok: false, error: "Order is not awaiting review." });
    if (req.body?.confirmBankVerified !== true) return res.status(400).json({ ok: false, error: "Confirm that the transaction and exact amount were verified in the bank/UPI account." });
    order.paymentStatus = "PAID"; order.paymentMethod = "UPI"; order.paidAt = new Date().toISOString(); order.verificationSource = "manual_admin";
    writeJson(ORDERS_FILE, replaceOrder(orders, order));
    await updateSheetPaymentStatus(order);
    await syncPaidOrder(order);
    res.json({ ok: true, orderId: order.orderId, paymentStatus: order.paymentStatus, collectionQrEmailed: order.qrEmailSent === true, message: "UPI order approved." });
  } catch (e) { console.error("UPI approval failed:", e.message); res.status(500).json({ ok: false, error: e.message || "Could not approve UPI order." }); }
});
app.post("/admin/orders/:orderId/retry-sheet", requireAdmin, async (req, res) => {
  try { const order = readJson(ORDERS_FILE).find(o => o.orderId === req.params.orderId); if (!order || order.paymentStatus !== "PAID") return res.status(404).json({ ok: false, error: "Paid order not found." }); if (!order.sheetSynced) await appendOrderToSheet(order); await syncPaidOrder(order); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.listen(PORT, () => {
  console.log(`IIT DH Merch Store running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Staff collection scanner: http://localhost:${PORT}/collection-staff.html`);
  if (!mailTransport()) console.log("SMTP email is not configured; paid-order QR emails will not send.");
  console.log("₹1 TEST MODE: orders are self-reported as PAID; staff must verify UTR in the receiving bank account before handing over merchandise.");
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) console.log("Google Sheets is not configured; paid orders cannot finish syncing until credentials are added.");
});
