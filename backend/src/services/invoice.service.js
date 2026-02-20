// backend/src/services/invoice.service.js
// Invoice Engine — Enterprise Grade • Revenue Separated • Audit Safe

const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

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

/* =========================================================
   CORE INVOICE CREATION
========================================================= */

function createInvoice({
  userId,
  type, // "subscription" | "autoprotect" | "tool"
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
  };

  updateDb((db) => {
    /* --------------------------------------------------
       Prevent duplicates (idempotent protection)
    -------------------------------------------------- */
    if (
      db.invoices.find(
        (i) =>
          i.stripeSessionId &&
          stripeSessionId &&
          i.stripeSessionId === stripeSessionId
      )
    ) {
      return;
    }

    db.invoices.push(invoice);

    /* --------------------------------------------------
       Revenue Accounting
    -------------------------------------------------- */
    db.revenueSummary.totalRevenue += amountUsd;

    if (type === "autoprotect") {
      db.revenueSummary.autoprotekRevenue += amountUsd;
    } else if (type === "subscription") {
      db.revenueSummary.subscriptionRevenue += amountUsd;
    } else if (type === "tool") {
      db.revenueSummary.toolRevenue += amountUsd;
    }
  });

  audit({
    actorId: userId,
    action: "INVOICE_CREATED",
    targetType: "Invoice",
    targetId: invoice.id,
    meta: {
      type,
      amount: amountUsd,
    },
  });

  return invoice;
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
  getUserInvoices,
  getAllInvoices,
};
