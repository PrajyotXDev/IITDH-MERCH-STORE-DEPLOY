// Usage: node scripts/make-staff-token.js alice
// Prints a NEW random token (give it to that staff member privately) and the "name:hash" entry
// to add to STAFF_TOKEN_HASHES in your hosting dashboard. The token itself is never stored.
const crypto = require("crypto");
const name = (process.argv[2] || "").trim();
if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(name)) { console.error("Give a staff name (letters, numbers, space . _ -)."); process.exit(1); }
const token = crypto.randomBytes(32).toString("base64url");
console.log("STAFF TOKEN (share privately, shown once):", token);
console.log("Add to STAFF_TOKEN_HASHES (comma-separated):", name + ":" + crypto.createHash("sha256").update(token).digest("hex"));
