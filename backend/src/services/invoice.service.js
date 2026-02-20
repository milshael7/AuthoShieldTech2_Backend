// backend/src/services/invoice.service.js
// Invoice Engine — Enterprise Grade • PDF Ready • Revenue Separated • Audit Safe

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

/* =========================================================
   CONFIG
========================================================= */

const INVOICE_DIR = path.join(__dirname, "..", "data", "invoices");

if (!fs.existsSync(INVOICE_DIR)) {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

/* =========================================================
   UTIL
========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 100000);
  return `INV-${year}-${rand}`;
}

function centsToUsd(cents) {
  return Number((cents / 100).toFixed(2));
}

function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}

/* =========================================================
   PDF GENERATION
========================================================= */

function generateInvoicePdf(invoice) {
  const filePath = path.join(INVOICE_DIR, `${invoice.invoiceNumber}.pdf`);

  if (fs.existsSync(filePath)) {
    return filePath;
  }

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  /* HEADER */
  doc.fontSize(20).text("INVOICE", { align: "right" });
  doc.moveDown();

  doc.fontSize(12);
  doc.text(`Invoice Number: ${invoice.invoiceNumber}`);
  doc.text(`Date: ${invoice.createdAt}`);
  doc.text(`User ID: ${invoice.userId}`);
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  /* LINE ITEMS */
  doc.fontSize(14).text("Service Breakdown", { underline: true });
  doc.moveDown();

  if (invoice.type === "subscription") {
    doc.text(`Automation Service: ${formatUsd(invoice.amount)}`);
  }

  if (invoice.type === "autoprotect") {
    doc.text(`Automation Service: ${formatUsd(invoice.amount - 50)}`);
    doc.text(`Platform Fee: ${formatUsd(50)}`);
  }

  if (invoice.type === "tool") {
    doc.text(`Security Tool Service: ${formatUsd(invoice.amount)}`);
  }

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  doc.fontSize(16).text(`Total Paid: ${formatUsd(invoice.amount)}`, {
    align: "right",
  });

  doc.moveDown(2);

  doc.fontSize(10).text(
    "This invoice reflects payment for platform services rendered. Platform fees are service-based charges and not tax representations.",
    { align: "left" }
  );

  doc.end();

  return filePath;
}

/* =========================================================
   CORE INVOICE CREATION
========================================================= */

function createInvoice({
  userId,
  type,
  stripeSessionId,
  stripeSubscriptionId,
  stripePaymentIntentId,
  amountPaidCents,
  meta = {},
}) {
  if (!userId || !amountPaidCents) {
    throw new Error("Invalid invoice payload");
  }

  const amountUsd = centsToUsd(amountPaidCents);

  const invoice = {
    id: nanoid(),
    invoiceNumber: generateInvoiceNumber(),
    userId,
    type,
    amount: amountUsd,
    currency: "USD",
    stripeSessionId: stripeSessionId || null,
    stripeSubscriptionId: stripeSubscriptionId || null,
    stripePaymentIntentId: stripePaymentIntentId || null,
    metadata: meta,
    createdAt: nowISO(),
    pdfPath: null,
  };

  updateDb((db) => {
    const duplicate = db.invoices.find(
      (i) =>
        i.stripeSessionId &&
        stripeSessionId &&
        i.stripeSessionId === stripeSessionId
    );

    if (duplicate) return;

    db.invoices.push(invoice);

    db.revenueSummary.totalRevenue += amountUsd;

    if (type === "autoprotect")
      db.revenueSummary.autoprotekRevenue += amountUsd;

    if (type === "subscription")
      db.revenueSummary.subscriptionRevenue += amountUsd;

    if (type === "tool")
      db.revenueSummary.toolRevenue += amountUsd;
  });

  audit({
    actorId: userId,
    action: "INVOICE_CREATED",
    targetType: "Invoice",
    targetId: invoice.id,
    meta: { type, amount: amountUsd },
  });

  return invoice;
}

/* =========================================================
   PDF ACCESS
========================================================= */

function getInvoicePdf(invoiceId) {
  const db = readDb();
  const invoice = db.invoices.find((i) => i.id === invoiceId);
  if (!invoice) throw new Error("Invoice not found");

  const filePath = generateInvoicePdf(invoice);

  updateDb((db2) => {
    const inv = db2.invoices.find((i) => i.id === invoiceId);
    if (inv) inv.pdfPath = filePath;
  });

  return filePath;
}

/* =========================================================
   QUERY
========================================================= */

function getUserInvoices(userId) {
  const db = readDb();
  return db.invoices.filter((i) => i.userId === userId);
}

function getAllInvoices() {
  const db = readDb();
  return db.invoices;
}

module.exports = {
  createInvoice,
  getInvoicePdf,
  getUserInvoices,
  getAllInvoices,
};
