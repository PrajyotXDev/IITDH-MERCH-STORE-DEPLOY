"use strict";
const { google } = require("googleapis");
const HEADERS = ["Order ID", "Created At", "Student Name", "Institute Email", "Roll Number", "Phone", "Batch/Program", "Items", "Subtotal", "Discount", "Coupon", "Total", "Currency", "Payment Status", "Payment Method", "UPI Reference", "Paid At", "Collection Status", "Collected At", "Screenshot"];
const PAY_LABEL = { AWAITING_PAYMENT: "AWAITING PAYMENT (not paid)", PENDING_REVIEW: "PENDING VERIFICATION (not paid)", PAID: "PAID (bank verified)", REJECTED: "REJECTED (not paid)" };
const COL_LABEL = { NOT_READY: "NOT READY", READY: "READY FOR COLLECTION", COLLECTED: "COLLECTED" };

function orderToRow(o) {
  const items = o.items.map(i => `${i.name} / ${i.color} / ${i.size} / qty ${i.quantity}${i.customName && i.customName !== "N/A" ? ` / print ${i.customName}` : ""}`).join("; ");
  return [o.orderId, o.createdAt, o.name, o.email, o.rollNo, o.phone, o.batchYear, items, o.subtotal, o.discount, o.couponCode || "", o.total, o.currency || "INR",
    o.paymentStatus === "PAID" && o.verificationSource === "razorpay_verified" ? "PAID (Razorpay verified)" : (PAY_LABEL[o.paymentStatus] || o.paymentStatus), o.paymentMethod || "UPI", o.upiReference || o.razorpayPaymentId || "",
    o.paymentStatus === "PAID" ? (o.verifiedAt || "") : "", COL_LABEL[o.collectionStatus] || o.collectionStatus, o.collectedAt || "", o.screenshotPath || ""];
}
const tabOf = env => env.GOOGLE_SHEETS_TAB || "Orders";
const q = tab => "'" + tab.replace(/'/g, "''") + "'";

function createSheets(env) {
  const configured = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && env.GOOGLE_SHEETS_SPREADSHEET_ID);
  let client; let chain = Promise.resolve(); // serialize upserts within one instance so one order never appends twice
  const api = () => {
    if (!client) {
      const creds = JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8"));
      client = google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
    }
    return client;
  };
  async function upsertNow(order) {
    if (!configured) throw new Error("Google Sheets is not configured");
    const s = api(), spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID, tab = q(tabOf(env));
    const head = (await s.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:T1` })).data.values?.[0];
    if (!head || head.length === 0) await s.spreadsheets.values.update({ spreadsheetId, range: `${tab}!A1:T1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
    else if (HEADERS.some((h, i) => head[i] !== h)) throw new Error("Sheet headers do not match the expected order columns; not modifying the sheet");
    const ids = (await s.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:A` })).data.values || [];
    const idx = ids.findIndex((r, i) => i > 0 && r[0] === order.orderId);
    const row = orderToRow(order);
    if (idx >= 0) await s.spreadsheets.values.update({ spreadsheetId, range: `${tab}!A${idx + 1}:T${idx + 1}`, valueInputOption: "RAW", requestBody: { values: [row] } });
    else await s.spreadsheets.values.append({ spreadsheetId, range: `${tab}!A:T`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] } });
    return idx >= 0 ? "updated" : "appended";
  }
  return {
    configured,
    upsertOrder(order) { const p = chain.then(() => upsertNow(order)); chain = p.catch(() => {}); return p; },
  };
}
module.exports = { createSheets, orderToRow, HEADERS };
