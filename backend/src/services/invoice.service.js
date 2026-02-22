// backend/src/services/invoice.service.js
// Phase 19 — SOC2 Financial Integrity Layer
// Immutable Ledger • Revenue Reconciliation • Refund Lineage • Drift Safe

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

/* =========================================================
   OPTIONAL PDFKIT (SAFE LOAD)
========================================================= */

let PDFDocument = null;
try {
  PDFDocument = require("pdfkit");
  console.log("[BOOT] PDFKit enabled");
} catch {
  console.log("[BOOT] PDFKit not installed — PDF generation disabled");
}

/* =========================================================
   CONFIG
========================================================= */

const INVOICE_DIR = path.join(__dirname, "..", "data", "invoices");

if (!fs.existsSync(INVOICE_DIR)) {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

/* =========================================================
   HASH UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeFinancialHash(invoice) {
  const base = JSON.stringify({
    id: invoice.id,
    userId: invoice.userId,
    type: invoice.type,
    amount: invoice.amount,
    stripePaymentIntentId: invoice.stripePaymentIntentId,
    stripeSubscriptionId: invoice.stripeSubscriptionId,
    createdAt: invoice.createdAt,
  });
  return sha256(base);
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
   SAFE PDF GENERATION
========================================================= */

function generateInvoicePdf(invoice) {
  if (!PDFDocument) {
    throw new Error("PDF generation not available (pdfkit not installed)");
  }

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

  doc.text(`Amount: ${formatUsd(invoice.amount)}`);

  if (invoice.type === "refund") {
    doc.moveDown();
    doc.fillColor("red").text("Refund Adjustment Applied");
    doc.fillColor("black");
  }

  doc.moveDown();
  doc.fontSize(16).text(
    `Total: ${formatUsd(invoice.amount)}`,
    { align: "right" }
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
    reconciliationStatus: "PENDING",
    pdfPath: null,
    hash: null,
  };

  invoice.hash = computeFinancialHash(invoice);

  updateDb((db) => {
    if (!Array.isArray(db.invoices)) db.invoices = [];
    if (!db.revenueSummary) {
      db.revenueSummary = {
        totalRevenue: 0,
        autoprotekRevenue: 0,
        subscriptionRevenue: 0,
        toolRevenue: 0,
      };
    }

    const duplicate = db.invoices.find(
      (i) =>
        stripePaymentIntentId &&
        i.stripePaymentIntentId === stripePaymentIntentId
    );

    if (duplicate) return;

    db.invoices.push(invoice);

    db.revenueSummary.totalRevenue += amountUsd;

    if (type === "subscription")
      db.revenueSummary.subscriptionRevenue += amountUsd;

    if (type === "autoprotect")
      db.revenueSummary.autoprotekRevenue += amountUsd;

    if (type === "tool")
      db.revenueSummary.toolRevenue += amountUsd;

    if (type === "refund") {
      db.revenueSummary.totalRevenue += amountUsd;
      db.revenueSummary.subscriptionRevenue += amountUsd;
    }
  });

  audit({
    actorId: userId,
    action: "FINANCIAL_EVENT_RECORDED",
    targetId: invoice.id,
    metadata: { type, amount: amountUsd },
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
    meta: { reason, linkedTo: stripePaymentIntentId },
  });
}

/* =========================================================
   PDF ACCESS
========================================================= */

function getInvoicePdf(invoiceId) {
  if (!PDFDocument) {
    throw new Error("PDF generation disabled");
  }

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
  return (db.invoices || []).filter((i) => i.userId === userId);
}

function getAllInvoices() {
  const db = readDb();
  return db.invoices || [];
}

module.exports = {
  createInvoice,
  createRefundInvoice,
  getInvoicePdf,
  getUserInvoices,
  getAllInvoices,
};
