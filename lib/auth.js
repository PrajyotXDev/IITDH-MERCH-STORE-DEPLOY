"use strict";
const crypto = require("crypto");

// STAFF_TOKEN_HASHES="alice:<sha256-hex>,bob:<sha256-hex>". Only hashes live in config; each token maps to a named staff member
// so approvals/collections are attributed to a real identity instead of a client-typed name.
function parseStaff(env) {
  const out = [];
  for (const part of String(env || "").split(",")) {
    const m = /^\s*([A-Za-z0-9 ._-]{1,40}):([a-f0-9]{64})\s*$/i.exec(part);
    if (m) out.push({ name: m[1].trim(), hash: Buffer.from(m[2].toLowerCase(), "hex") });
  }
  return out;
}
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return arr.length <= max;
  };
}
function makeStaffAuth(envValue) {
  const staff = parseStaff(envValue);
  const failLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 15 });
  const middleware = (req, res, next) => {
    if (!staff.length) return res.status(503).json({ ok: false, error: "Staff access is not configured." });
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.get("authorization") || "");
    let who = null;
    if (m) {
      const h = crypto.createHash("sha256").update(m[1]).digest();
      for (const s of staff) if (crypto.timingSafeEqual(h, s.hash)) who = s.name; // compares all: no early exit
    }
    if (!who) {
      if (!failLimit(req.ip || "?")) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
      return res.status(401).json({ ok: false, error: "Staff authentication failed." });
    }
    req.staff = who; next();
  };
  middleware.configured = staff.length > 0;
  return middleware;
}
module.exports = { makeStaffAuth, rateLimiter, parseStaff };
