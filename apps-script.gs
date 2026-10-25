const SCRIPT_PROPERTY_KEYS = {
  spreadsheetId: "MERCH_SPREADSHEET_ID",
  uploadFolderId: "MERCH_UPLOAD_FOLDER_ID"
};

function setup() {
  const properties = PropertiesService.getScriptProperties();
  let spreadsheet;
  let folder;

  const spreadsheetId = properties.getProperty(SCRIPT_PROPERTY_KEYS.spreadsheetId);
  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create("IIT DH Merch Store submissions");
    properties.setProperty(SCRIPT_PROPERTY_KEYS.spreadsheetId, spreadsheet.getId());
  }

  const uploadFolderId = properties.getProperty(SCRIPT_PROPERTY_KEYS.uploadFolderId);
  if (uploadFolderId) {
    folder = DriveApp.getFolderById(uploadFolderId);
  } else {
    folder = DriveApp.createFolder("IIT DH Merch Store payment screenshots");
    properties.setProperty(SCRIPT_PROPERTY_KEYS.uploadFolderId, folder.getId());
  }

  const orders = getOrCreateSheet_(spreadsheet, "Orders", [
    "Received At", "Order ID", "Name", "Institute Email", "Roll Number",
    "Phone", "Batch / Program", "Coupon", "Items JSON", "Subtotal",
    "Discount", "Total", "Screenshot File ID"
  ]);
  getOrCreateSheet_(spreadsheet, "Visits", [
    "Received At", "Visitor ID", "Page", "Referrer", "User Agent",
    "Screen", "Language", "Visit Number", "New Visitor"
  ]);

  Logger.log("Spreadsheet: " + spreadsheet.getUrl());
  Logger.log("Screenshot folder: " + folder.getUrl());
  return { spreadsheetUrl: spreadsheet.getUrl(), ordersSheet: orders.getName() };
}

function doPost(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throw new Error("Expected a JSON request body.");
  }

  const payload = JSON.parse(event.postData.contents);
  if (payload.type === "visit") {
    recordVisit_(payload);
  } else {
    recordOrder_(payload);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function recordOrder_(payload) {
  const name = requiredText_(payload.name, "name", 120);
  const email = requiredText_(payload.email, "email", 254).toLowerCase();
  const rollNo = requiredText_(payload.rollNo, "rollNo", 80);
  const phone = requiredText_(payload.phone, "phone", 10);
  const batchYear = requiredText_(payload.batchYear, "batchYear", 120);
  const orderId = requiredText_(payload.orderId, "orderId", 80);
  if (!email.endsWith("@iitdh.ac.in")) throw new Error("Invalid institute email.");
  if (!/^\d{10}$/.test(phone)) throw new Error("Invalid phone number.");
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 50) {
    throw new Error("Invalid order items.");
  }

  const subtotal = nonNegativeNumber_(payload.subtotal, "subtotal");
  const discount = nonNegativeNumber_(payload.discount, "discount");
  const total = nonNegativeNumber_(payload.total, "total");
  if (total <= 0 || discount > subtotal) throw new Error("Invalid order total.");

  const items = payload.items.map(function(item) {
    return {
      name: requiredText_(item.name, "item name", 120),
      price: nonNegativeNumber_(item.price, "item price"),
      quantity: positiveInteger_(item.quantity, "item quantity"),
      size: requiredText_(item.size, "item size", 20),
      color: requiredText_(item.color, "item color", 40),
      customName: requiredText_(item.customName || "N/A", "custom name", 80)
    };
  });
  const screenshot = saveScreenshot_(payload, orderId);

  const receivedAt = new Date();
  appendRow_("Orders", [
    receivedAt, safeCellText_(orderId), safeCellText_(name), safeCellText_(email),
    safeCellText_(rollNo), safeCellText_(phone), safeCellText_(batchYear),
    safeCellText_(payload.couponCode || ""), JSON.stringify(items),
    subtotal, discount, total, screenshot.getId()
  ]);

  // Send the student a plain-text order summary after the order is recorded.
  // Email failures are logged but do not roll back the saved order.
  try {
    sendOrderSummaryEmail_({
      email: email,
      name: name,
      orderId: orderId,
      receivedAt: receivedAt,
      items: items,
      subtotal: subtotal,
      discount: discount,
      total: total,
      couponCode: payload.couponCode || ""
    });
  } catch (emailError) {
    console.error("Order saved, but confirmation email failed for " + email + ": " + emailError);
  }
}

function sendOrderSummaryEmail_(order) {
  const itemLines = order.items.map(function(item, index) {
    const lineTotal = item.price * item.quantity;
    return (index + 1) + ". " + item.name +
      " | Color: " + item.color +
      " | Size: " + item.size +
      " | Qty: " + item.quantity +
      " | Unit price: " + formatRupees_(item.price) +
      " | Line total: " + formatRupees_(lineTotal) +
      (item.customName && item.customName !== "N/A" ? " | Custom name: " + item.customName : "");
  });

  const subject = "IIT DH Merch Store — Order summary " + order.orderId;
  const body = [
    "Hi " + order.name + ",",
    "",
    "Thank you for placing an order with the IIT DH Merch Store.",
    "",
    "ORDER SUMMARY",
    "Order ID: " + order.orderId,
    "Order date: " + Utilities.formatDate(order.receivedAt, Session.getScriptTimeZone(), "dd MMM yyyy, hh:mm a"),
    "",
    "ITEMS",
    itemLines.join("\\n"),
    "",
    "Subtotal: " + formatRupees_(order.subtotal),
    "Discount: -" + formatRupees_(order.discount),
    "Coupon: " + (order.couponCode || "None"),
    "Order total: " + formatRupees_(order.total),
    "",
    "PAYMENT STATUS: PENDING MANUAL VERIFICATION",
    "This email confirms that we received your order details; it does not confirm that payment has been received. The merch team will verify the payment against its bank/UPI records before confirming fulfilment.",
    "",
    "If any order detail looks incorrect, please contact the IIT DH Merch Store team.",
    "",
    "Regards,",
    "IIT DH Merch Store"
  ].join("\\n");

  MailApp.sendEmail({
    to: order.email,
    subject: subject,
    body: body,
    name: "IIT DH Merch Store"
  });
}

function formatRupees_(amount) {
  return "Rs. " + Number(amount).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function recordVisit_(payload) {
  appendRow_("Visits", [
    new Date(),
    safeCellText_(limitedText_(payload.visitorId, 100)),
    safeCellText_(limitedText_(payload.page, 500)),
    safeCellText_(limitedText_(payload.referrer, 1000)),
    safeCellText_(limitedText_(payload.userAgent, 1000)),
    safeCellText_(limitedText_(payload.screen, 40)),
    safeCellText_(limitedText_(payload.language, 40)),
    positiveInteger_(payload.visitNumber, "visitNumber"),
    payload.isNew === true
  ]);
}

function saveScreenshot_(payload, orderId) {
  const dataUrl = requiredText_(payload.screenshotData, "screenshotData", 12000000);
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/);
  if (!match) throw new Error("Payment screenshot must be a JPEG, PNG, or WebP image.");

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Payment screenshot exceeds the 8 MB limit.");
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[match[1]];
  const blob = Utilities.newBlob(bytes, match[1], safeFileName_(orderId) + "." + extension);
  const folderId = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.uploadFolderId);
  if (!folderId) throw new Error("Run setup() before accepting submissions.");
  return DriveApp.getFolderById(folderId).createFile(blob);
}

function appendRow_(sheetName, values) {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.spreadsheetId);
  if (!spreadsheetId) throw new Error("Run setup() before accepting submissions.");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName).appendRow(values);
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  return sheet;
}

function requiredText_(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error("Invalid " + label + ".");
  }
  return value.trim();
}

function limitedText_(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function nonNegativeNumber_(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid " + label + ".");
  }
  return value;
}

function positiveInteger_(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error("Invalid " + label + ".");
  return value;
}

function safeCellText_(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function safeFileName_(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}
