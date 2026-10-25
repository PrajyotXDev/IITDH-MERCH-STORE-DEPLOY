"use strict";
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const QR_PREFIX = "IITDH-MERCH-COLLECTION:";
const itemLines = o => o.items.map((i, n) => `${n + 1}. ${i.name} | ${i.color} | Size ${i.size} | Qty ${i.quantity}${i.customName && i.customName !== "N/A" ? ` | Print: ${i.customName}` : ""} | ₹${i.lineTotal}`).join("\n");

function createMail(env) {
  const configured = Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);
  let transport;
  const tx = () => transport || (transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT), secure: String(env.SMTP_SECURE || "").toLowerCase() === "true" || Number(env.SMTP_PORT) === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 8000, socketTimeout: 10000 }));
  const from = `"IIT DH Merch Store" <${env.MAIL_FROM || env.SMTP_USER}>`;
  // Resolves true ONLY when the SMTP server accepted the recipient; otherwise throws.
  async function send(msg) {
    if (!configured) throw new Error("SMTP is not configured");
    const info = await tx().sendMail({ from, ...msg });
    if (!info.accepted || !info.accepted.length) throw new Error("SMTP server did not accept the recipient");
    return true;
  }
  return {
    configured,
    sendAck: o => send({ to: o.email, subject: `Order received — payment pending verification (${o.orderId})`, text: [`Hi ${o.name},`, "", "We received your IIT Dharwad Merch Store order and payment details.", `Order ID: ${o.orderId}`, `Amount to be verified: ₹${o.total}`, "", "PAYMENT PENDING VERIFICATION", "Your payment is NOT confirmed yet. Staff will check the UTR and amount in the receiving bank account. Your collection QR will be emailed only after that check succeeds.", "", "ITEMS", itemLines(o), "", "IIT Dharwad Merch Store"].join("\n") }),
    async sendQr(o, token) {
      const png = await QRCode.toBuffer(QR_PREFIX + token, { type: "png", errorCorrectionLevel: "H", margin: 2, width: 420 });
      return send({ to: o.email, subject: `Payment confirmed — merch collection QR (${o.orderId})`, text: [`Hi ${o.name},`, "", o.verificationSource === "razorpay_verified" ? "Your payment was confirmed by Razorpay." : "Your payment has been verified by staff.", `Order ID: ${o.orderId}`, `Confirmed amount: ₹${o.total}`, "", "ITEMS", itemLines(o), "", "HOW TO COLLECT", "Show the attached QR at the collection counter. It can be used only once. Keep it private: anyone holding it may try to claim this order.", "", "IIT Dharwad Merch Store"].join("\n"), attachments: [{ filename: `${o.orderId}-collection-qr.png`, content: png, contentType: "image/png" }] });
    },
  };
}
module.exports = { createMail, QR_PREFIX };
