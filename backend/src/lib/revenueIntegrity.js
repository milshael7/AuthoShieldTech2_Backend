// Enterprise Revenue Ledger Integrity Engine v1
// Deterministic • Hash Verified • Tamper Detect • Boot Safe

const crypto = require("crypto");
const { readDb } = require("./db");

/* =========================================================
   HELPERS
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeLedgerHash(entry) {
  const clone = { ...entry };
  delete clone.hash; // never include stored hash in computation
  return sha256(JSON.stringify(clone));
}

function safeArray(arr) {
  return Array.isArray(arr) ? arr : [];
}

/* =========================================================
   PAYMENTS VALIDATION
========================================================= */

function validatePayments(db) {
  const payments = safeArray(db.payments);

  for (const payment of payments) {
    if (!payment.hash) {
      return {
        ok: false,
        reason: "Missing payment hash",
        paymentId: payment.id,
      };
    }

    const computed = computeLedgerHash(payment);

    if (computed !== payment.hash) {
      return {
        ok: false,
        reason: "Payment hash mismatch",
        paymentId: payment.id,
      };
    }
  }

  return { ok: true };
}

/* =========================================================
   REFUNDS VALIDATION
========================================================= */

function validateRefunds(db) {
  const refunds = safeArray(db.refunds);

  for (const refund of refunds) {
    if (!refund.hash) {
      return {
        ok: false,
        reason: "Missing refund hash",
        refundId: refund.id,
      };
    }

    const computed = computeLedgerHash(refund);

    if (computed !== refund.hash) {
      return {
        ok: false,
        reason: "Refund hash mismatch",
        refundId: refund.id,
      };
    }
  }

  return { ok: true };
}

/* =========================================================
   REVENUE SUMMARY CONSISTENCY
========================================================= */

function validateRevenueSummary(db) {
  const payments = safeArray(db.payments);
  const refunds = safeArray(db.refunds);

  const summary = db.revenueSummary || {};

  const totalPayments = payments.reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );

  const totalRefunds = refunds.reduce(
    (sum, r) => sum + (Number(r.amount) || 0),
    0
  );

  const expectedRevenue = Math.max(0, totalPayments - totalRefunds);
  const recordedRevenue = Number(summary.totalRevenue || 0);

  if (Math.abs(expectedRevenue - recordedRevenue) > 0.01) {
    return {
      ok: false,
      reason: "Revenue summary mismatch",
      expectedRevenue,
      recordedRevenue,
    };
  }

  return { ok: true };
}

/* =========================================================
   MAIN VERIFIER
========================================================= */

function verifyRevenueLedger() {
  try {
    const db = readDb();

    const paymentsCheck = validatePayments(db);
    if (!paymentsCheck.ok) return paymentsCheck;

    const refundsCheck = validateRefunds(db);
    if (!refundsCheck.ok) return refundsCheck;

    const revenueCheck = validateRevenueSummary(db);
    if (!revenueCheck.ok) return revenueCheck;

    return {
      ok: true,
      timestamp: Date.now(),
    };

  } catch (err) {
    return {
      ok: false,
      reason: "Ledger verification failure",
      error: err.message,
    };
  }
}

module.exports = {
  verifyRevenueLedger,
};
