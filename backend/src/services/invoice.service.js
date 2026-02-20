// backend/src/services/invoice.service.js
// Invoice Engine — Enterprise Financial Integrity Layer
// Refund Safe • Dispute Safe • Revenue Reconciliation Ready • PDF Ready

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

  if (fs.existsSync(filePath)) return filePath;

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(20).text("INVOICE", { align: "right" });
  doc.moveDown();

  doc.fontSize(12);
  doc.text(`Invoice Number: ${invoice.invoiceNumber}`);
  doc.text(`Date: ${invoice.createdAt}`);
  doc.text(`User ID: ${invoice.userId}`);
  doc.text(`Type: ${invoice.type}`);
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  doc.fontSize(14).text("Service Breakdown", { underline: true });
  doc.moveDown();

  doc.text(`Amount: ${formatUsd(invoice.amount)}`);

  if (invoice.type === "refund") {
    doc.moveDown();
    doc.fillColor("red").text("Refund Adjustment Applied");
    doc.fillColor("black");
  }

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  doc.fontSize(16).text(
    `Total: ${formatUsd(invoice.amount)}`,
    { align: "right" }
  );

  doc.moveDown(2);

  doc.fontSize(10).text(
    "This invoice reflects platform service transactions. Platform fees are service-based charges and not tax representations.",
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
  if (!userId || typeof amountPaidCents !== "number") {
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
    // 🔐 Idempotency protection
    const duplicate = db.invoices.find(
      (i) =>
        stripePaymentIntentId &&
        i.stripePaymentIntentId === stripePaymentIntentId
    );

    if (duplicate) return;

    db.invoices.push(invoice);

    // 🔥 Revenue reconciliation
    db.revenueSummary.totalRevenue += amountUsd;

    if (type === "autoprotect")
      db.revenueSummary.autoprotekRevenue += amountUsd;

    if (type === "subscription")
      db.revenueSummary.subscriptionRevenue += amountUsd;

    if (type === "tool")
      db.revenueSummary.toolRevenue += amountUsd;

    if (type === "refund") {
      db.revenueSummary.totalRevenue -= Math.abs(amountUsd);
    }
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
   REFUND ENGINE
========================================================= */

function createRefundInvoice({
  userId,
  stripePaymentIntentId,
  amountRefundedCents,
  reason = "refund",
}) {
  return createInvoice({
    userId,
    type: "refund",
    stripePaymentIntentId,
    amountPaidCents: -Math.abs(amountRefundedCents),
    meta: { reason },
  });
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
  createRefundInvoice,
  getInvoicePdf,
  getUserInvoices,
  getAllInvoices,
};
