// backend/src/services/compliance.service.js
// Phase 21 — SOC2 Compliance Engine
// Financial Reconciliation • Ledger Validation • Drift Detection

const Stripe = require("stripe");
const { readDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   INTERNAL REVENUE RECALCULATION
========================================================= */

function calculateInternalRevenue(db) {
  const invoices = db.invoices || [];

  let total = 0;
  let subscription = 0;

  for (const inv of invoices) {
    total += inv.amount;

    if (inv.type === "subscription")
      subscription += inv.amount;

    if (inv.type === "refund")
      subscription += inv.amount;
  }

  return {
    totalRevenueCalculated: Number(total.toFixed(2)),
    subscriptionRevenueCalculated: Number(subscription.toFixed(2)),
  };
}

/* =========================================================
   DUPLICATE INVOICE DETECTION
========================================================= */

function detectDuplicateInvoices(db) {
  const seen = new Set();
  const duplicates = [];

  for (const inv of db.invoices || []) {
    if (!inv.stripePaymentIntentId) continue;

    if (seen.has(inv.stripePaymentIntentId)) {
      duplicates.push(inv);
    }

    seen.add(inv.stripePaymentIntentId);
  }

  return duplicates;
}

/* =========================================================
   ORPHAN PAYMENT DETECTION
========================================================= */

function detectOrphanPayments(db) {
  const invoices = db.invoices || [];
  const payments = db.payments || [];

  const invoicePaymentIds = new Set(
    invoices.map(i => i.stripePaymentIntentId).filter(Boolean)
  );

  return payments.filter(
    p => !invoicePaymentIds.has(p.stripePaymentIntentId)
  );
}

/* =========================================================
   REFUND MISMATCH DETECTION
========================================================= */

function detectRefundMismatch(db) {
  const refunds = db.refunds || [];
  const payments = db.payments || [];

  const mismatches = [];

  for (const refund of refunds) {
    const payment = payments.find(
      p => p.stripePaymentIntentId === refund.stripePaymentIntentId
    );

    if (!payment) {
      mismatches.push({
        type: "missing_payment",
        refund,
      });
      continue;
    }

    if (refund.amount > payment.amount) {
      mismatches.push({
        type: "refund_exceeds_payment",
        refund,
        payment,
      });
    }
  }

  return mismatches;
}

/* =========================================================
   STRIPE LIVE RECONCILIATION (OPTIONAL CHECK)
========================================================= */

async function fetchStripeRecentPayments(limit = 50) {
  const sessions = await stripe.paymentIntents.list({
    limit,
  });

  return sessions.data.map(p => ({
    id: p.id,
    amount: p.amount_received / 100,
    status: p.status,
  }));
}

/* =========================================================
   MAIN COMPLIANCE REPORT
========================================================= */

async function generateComplianceReport() {
  const db = readDb();

  const internalRevenue = calculateInternalRevenue(db);

  const storedRevenue = {
    totalRevenueStored: Number(
      (db.revenueSummary?.totalRevenue || 0).toFixed(2)
    ),
    subscriptionRevenueStored: Number(
      (db.revenueSummary?.subscriptionRevenue || 0).toFixed(2)
    ),
  };

  const revenueDrift =
    internalRevenue.totalRevenueCalculated -
    storedRevenue.totalRevenueStored;

  const duplicateInvoices = detectDuplicateInvoices(db);
  const orphanPayments = detectOrphanPayments(db);
  const refundMismatches = detectRefundMismatch(db);

  const auditIntegrity = verifyAuditIntegrity();

  return {
    generatedAt: new Date().toISOString(),

    financialIntegrity: {
      internalRevenue,
      storedRevenue,
      revenueDrift: Number(revenueDrift.toFixed(2)),
    },

    anomalies: {
      duplicateInvoices: duplicateInvoices.length,
      orphanPayments: orphanPayments.length,
      refundMismatches: refundMismatches.length,
    },

    details: {
      duplicateInvoices,
      orphanPayments,
      refundMismatches,
    },

    auditIntegrity,
  };
}

module.exports = {
  generateComplianceReport,
};
