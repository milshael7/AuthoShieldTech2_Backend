// backend/src/services/compliance.service.js
// Phase 24 — Automated SOC2 Compliance Engine
// Financial Reconciliation • Drift Detection • Snapshot Archiving • Retention Enforcement

const crypto = require("crypto");
const Stripe = require("stripe");
const { readDb, updateDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function nowISO() {
  return new Date().toISOString();
}

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
   ANOMALY DETECTORS
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
   RETENTION ENFORCEMENT
========================================================= */

function enforceRetentionPolicies() {
  updateDb((db) => {
    const now = Date.now();
    const policy = db.retentionPolicy || {};

    const auditCutoff =
      now - (policy.auditRetentionDays || 730) * 24 * 60 * 60 * 1000;

    db.audit = db.audit.filter(
      (a) => a.ts >= auditCutoff
    );

    const snapshotCutoff =
      now - (policy.snapshotRetentionDays || 1095) * 24 * 60 * 60 * 1000;

    db.complianceSnapshots = db.complianceSnapshots.filter(
      (s) => new Date(s.generatedAt).getTime() >= snapshotCutoff
    );

    return db;
  });
}

/* =========================================================
   SNAPSHOT GENERATION
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

  const snapshot = {
    id: crypto.randomUUID(),
    generatedAt: nowISO(),

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

    auditIntegrity,
  };

  snapshot.hash = sha256(JSON.stringify(snapshot));

  updateDb((db2) => {
    db2.complianceSnapshots.push(snapshot);
    return db2;
  });

  enforceRetentionPolicies();

  return snapshot;
}

/* =========================================================
   HISTORY ACCESS
========================================================= */

function getComplianceHistory(limit = 20) {
  const db = readDb();
  return (db.complianceSnapshots || [])
    .slice(-limit)
    .reverse();
}

module.exports = {
  generateComplianceReport,
  getComplianceHistory,
};
