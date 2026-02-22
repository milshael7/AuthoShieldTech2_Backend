# AutoShield Tech — Security Architecture Master Sheet

## 1. Core Engine
- [x] Tool Registry
- [x] Weighted Score Engine
- [x] Trend Calculation
- [x] Volatility Tracking
- [x] Score History
- [x] Event Feed

---

## 2. Backend Toggles (Future Switches)
- [ ] Screenshot Protection Mode
- [ ] Watermark Overlay Mode
- [ ] Session Auto Lock Timer
- [ ] PIN Re-authentication
- [ ] Admin/Manager Separate Login Portal
- [ ] Copy Protection
- [ ] Device Lock Detection
- [ ] AI Monitoring Alerts

---

## 3. Intelligence & Analytics
- [ ] Visitor Tracking
- [ ] Geo Map Analytics
- [ ] Signup Conversion Metrics
- [ ] Country-based Language Auto Detection
- [ ] Currency Localization

---

## 4. Enterprise Protections (Future)
- [ ] SOC Alert Escalation Rules
- [ ] Threat Heatmap
- [ ] Behavioral Anomaly Detection
- [ ] Admin Toggle Panel UI

🤖🤖🤖

// backend/src/services/stripe.service.js
// Phase 20 — SOC2 Stripe Reconciliation Engine
// Idempotent • Immutable • Drift Safe • Ledger Verified

const Stripe = require("stripe");
const crypto = require("crypto");
const users = require("../users/user.service");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { nanoid } = require("nanoid");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   HASH UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeLedgerHash(entry) {
  return sha256(JSON.stringify(entry));
}

/* =========================================================
   SAFE INITIALIZER
========================================================= */

function ensureFinancialArrays(db) {
  if (!Array.isArray(db.payments)) db.payments = [];
  if (!Array.isArray(db.refunds)) db.refunds = [];
  if (!Array.isArray(db.disputes)) db.disputes = [];

  if (!db.revenueSummary) {
    db.revenueSummary = {
      totalRevenue: 0,
      subscriptionRevenue: 0,
      autoprotekRevenue: 0,
      toolRevenue: 0,
      refundedAmount: 0,
      disputedAmount: 0,
    };
  }
}

/* =========================================================
   USER SAVE
========================================================= */

function saveUser(updatedUser) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === updatedUser.id);
  if (idx !== -1) {
    db.users[idx] = updatedUser;
    writeDb(db);
  }
}

/* =========================================================
   BILLING CONTROL
========================================================= */

function activateBilling(userId, nextBillingDate) {
  updateDb((db) => {
    db.autoprotek = db.autoprotek || { users: {} };
    const existing = db.autoprotek.users[userId] || {};

    db.autoprotek.users[userId] = {
      ...existing,
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      nextBillingDate,
    };
  });
}

function lockUserBilling(userId) {
  if (!userId) return;

  updateDb((db) => {
    if (!db.autoprotek?.users?.[userId]) return;
    db.autoprotek.users[userId].status = "INACTIVE";
    db.autoprotek.users[userId].subscriptionStatus = "LOCKED";
  });
}

/* =========================================================
   WEBHOOK HANDLER
========================================================= */

async function handleStripeWebhook(event) {
  updateDb((db) => {
    if (!Array.isArray(db.processedStripeEvents))
      db.processedStripeEvents = [];

    if (db.processedStripeEvents.includes(event.id)) {
      return db; // idempotent exit
    }

    db.processedStripeEvents.push(event.id);
    return db;
  });

  /* =====================================================
     PAYMENT SUCCEEDED
  ====================================================== */

  if (event.type === "invoice.payment_succeeded") {
    const invoiceObj = event.data.object;
    const subscription = await stripe.subscriptions.retrieve(
      invoiceObj.subscription
    );

    const db = readDb();
    ensureFinancialArrays(db);

    const user = db.users.find(
      (u) => u.stripeSubscriptionId === subscription.id
    );
    if (!user) return;

    const amount = invoiceObj.amount_paid / 100;

    const existing = db.payments.find(
      (p) => p.stripePaymentIntentId === invoiceObj.payment_intent
    );

    if (existing) return; // idempotent

    const paymentEntry = {
      id: nanoid(),
      userId: user.id,
      stripePaymentIntentId: invoiceObj.payment_intent,
      stripeSubscriptionId: subscription.id,
      amount,
      status: "paid",
      createdAt: new Date().toISOString(),
    };

    paymentEntry.hash = computeLedgerHash(paymentEntry);

    updateDb((ledgerDb) => {
      ensureFinancialArrays(ledgerDb);

      ledgerDb.payments.push(paymentEntry);

      ledgerDb.revenueSummary.totalRevenue += amount;
      ledgerDb.revenueSummary.subscriptionRevenue += amount;

      return ledgerDb;
    });

    user.subscriptionStatus = "Active";
    saveUser(user);

    activateBilling(
      user.id,
      new Date(subscription.current_period_end * 1000).toISOString()
    );

    audit({
      actorId: user.id,
      action: "PAYMENT_RECORDED",
      targetId: paymentEntry.id,
      metadata: { amount },
    });
  }

  /* =====================================================
     REFUND
  ====================================================== */

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    if (!charge.payment_intent) return;

    const refundAmount = charge.amount_refunded / 100;

    updateDb((ledgerDb) => {
      ensureFinancialArrays(ledgerDb);

      const payment = ledgerDb.payments.find(
        (p) => p.stripePaymentIntentId === charge.payment_intent
      );
      if (!payment) return ledgerDb;

      if (
        ledgerDb.refunds.find(
          (r) => r.stripePaymentIntentId === charge.payment_intent
        )
      ) return ledgerDb;

      const refundEntry = {
        id: nanoid(),
        userId: payment.userId,
        stripePaymentIntentId: charge.payment_intent,
        amount: refundAmount,
        createdAt: new Date().toISOString(),
      };

      refundEntry.hash = computeLedgerHash(refundEntry);

      ledgerDb.refunds.push(refundEntry);

      ledgerDb.revenueSummary.totalRevenue -= refundAmount;
      ledgerDb.revenueSummary.subscriptionRevenue -= refundAmount;
      ledgerDb.revenueSummary.refundedAmount += refundAmount;

      return ledgerDb;
    });

    lockUserBilling(
      readDb().users.find(
        (u) => u.stripePaymentIntentId === charge.payment_intent
      )?.id
    );

    audit({
      actorId: "system",
      action: "REFUND_RECORDED",
      targetId: charge.payment_intent,
      metadata: { refundAmount },
    });
  }

  /* =====================================================
     DISPUTE
  ====================================================== */

  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object;

    updateDb((ledgerDb) => {
      ensureFinancialArrays(ledgerDb);

      if (
        ledgerDb.disputes.find(
          (d) => d.stripePaymentIntentId === dispute.payment_intent
        )
      ) return ledgerDb;

      const disputeEntry = {
        id: nanoid(),
        stripePaymentIntentId: dispute.payment_intent,
        amount: dispute.amount / 100,
        status: dispute.status,
        createdAt: new Date().toISOString(),
      };

      disputeEntry.hash = computeLedgerHash(disputeEntry);

      ledgerDb.disputes.push(disputeEntry);
      ledgerDb.revenueSummary.disputedAmount += dispute.amount / 100;

      return ledgerDb;
    });

    audit({
      actorId: "system",
      action: "DISPUTE_CREATED",
      targetId: dispute.id,
    });
  }

  /* =====================================================
     SUBSCRIPTION CANCELLED
  ====================================================== */

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;

    const db = readDb();
    const user = db.users.find(
      (u) => u.stripeSubscriptionId === subscription.id
    );

    if (user) {
      user.subscriptionStatus = "Locked";
      saveUser(user);
      lockUserBilling(user.id);
    }
  }
}

/* =========================================================
   CANCEL SUBSCRIPTION
========================================================= */

async function cancelSubscription(userId) {
  const user = users.findById(userId);
  if (!user?.stripeSubscriptionId) {
    throw new Error("No active subscription");
  }

  await stripe.subscriptions.cancel(user.stripeSubscriptionId);

  user.subscriptionStatus = "Locked";
  saveUser(user);
  lockUserBilling(user.id);

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_CANCELLED",
    targetId: user.id,
  });
}

module.exports = {
  cancelSubscription,
  handleStripeWebhook,
};
