"use strict";
const crypto = require("crypto");

// TEST MODE: every item costs exactly ₹1. Prices live ONLY on the server.
const PRODUCT_PRICES = Object.freeze({ "Classic T-Shirt": 1, "Polo T-Shirt": 1, "Zipper Hoodie": 1, "CS Hoodie": 1, "EE Hoodie": 1 });
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1000;

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const bad = (msg, code) => new HttpError(400, msg, code);

function cleanText(v, label, max = 200) {
  if (typeof v !== "string") throw bad("Please check the " + label + " field.");
  const t = v.trim();
  if (!t || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) throw bad("Please check the " + label + " field.");
  return t;
}

function calculateOrder(payload) {
  if (!payload || typeof payload !== "object") throw bad("Invalid request.");
  const name = cleanText(payload.name, "name", 120);
  const email = cleanText(payload.email, "email", 254).toLowerCase();
  const rollNo = cleanText(payload.rollNo, "roll number", 80);
  const phone = cleanText(payload.phone, "phone", 10);
  const batchYear = cleanText(payload.batchYear, "batch/program", 120);
  if (!/^[^@\s]+@iitdh\.ac\.in$/.test(email)) throw bad("Please use your @iitdh.ac.in institute email.");
  if (!/^\d{10}$/.test(phone)) throw bad("Phone number must contain exactly 10 digits.");
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 50) throw bad("Invalid order items.");
  const items = payload.items.map(raw => {
    if (!raw || typeof raw !== "object") throw bad("Invalid order items.");
    const itemName = cleanText(raw.name, "product", 120);
    if (!Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, itemName)) throw bad("Unknown product.");
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw bad("Invalid item quantity.");
    const color = cleanText(raw.color, "color", 40);
    const size = cleanText(raw.size, "size", 20);
    const cn = raw.customName == null || raw.customName === "" ? "N/A" : raw.customName;
    const customName = cleanText(String(cn), "custom print", 80);
    const unitPrice = PRODUCT_PRICES[itemName]; // client-sent price/total fields are never read
    return { name: itemName, color, size, quantity, customName, unitPrice, lineTotal: unitPrice * quantity };
  });
  if (String(payload.couponCode || "").trim()) throw bad("Coupons are disabled in ₹1 test mode. Clear the coupon field and try again.");
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const total = subtotal;
  return { name, email, rollNo, phone, batchYear, items, subtotal, discount: 0, couponCode: "", total };
}

function validateUtr(v) {
  const u = cleanText(v, "UPI transaction reference", 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(u)) throw bad("Enter a valid UPI UTR/reference (8–80 letters or digits).");
  return u;
}

// Real file-signature sniffing; declared MIME and filename are never trusted.
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

function parseScreenshot(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) throw bad("Upload your payment screenshot.");
  if (dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw bad("Screenshot must be under 3 MB.");
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw bad("Upload the payment screenshot as a JPG, PNG or WebP image.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw bad("Screenshot must be under 3 MB.");
  if (buf.length < MIN_IMAGE_BYTES) throw bad("Screenshot must be a real image.");
  const real = sniffImage(buf);
  if (!real) throw bad("The uploaded file is not a valid image.");
  const declared = m[1] === "jpeg" ? "image/jpeg" : "image/" + m[1];
  if (real.mime !== declared) throw bad("The uploaded file is not a valid image.");
  return { buf, mime: real.mime, ext: real.ext, hash: crypto.createHash("sha256").update(buf).digest("hex") };
}

const newOrderId = () => "IITDH-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
const newCollectionToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = t => crypto.createHash("sha256").update(t).digest("hex");

module.exports = { PRODUCT_PRICES, HttpError, calculateOrder, validateUtr, parseScreenshot, sniffImage, newOrderId, newCollectionToken, hashToken, MAX_IMAGE_BYTES };
