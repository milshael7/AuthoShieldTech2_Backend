// backend/src/services/stripe.service.js
// Stripe Service — Enterprise Financial Ledger Integrated
// Payments • Refunds • Disputes • Revenue Reversal Safe

const Stripe = require("stripe");
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
   INTERNAL SAVE
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
   AUTOPROTECT STATE CONTROL
========================================================= */

function activateAutoProtectBilling(userId, nextBillingDate) {
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
  const db = readDb();

  if (!Array.isArray(db.processedStripeEvents)) {
    db.processedStripeEvents = [];
  }

  if (db.processedStripeEvents.includes(event.id)) {
    return;
  }

  db.processedStripeEvents.push(event.id);
  writeDb(db);

  /* =====================================================
     PAYMENT SUCCEEDED
  ====================================================== */

  if (event.type === "invoice.payment_succeeded") {
    const invoiceObj = event.data.object;

    const subscription = await stripe.subscriptions.retrieve(
      invoiceObj.subscription
    );

    const nextBillingDate = new Date(
      subscription.current_period_end * 1000
    ).toISOString();

    const db2 = readDb();
    const user = db2.users.find(
      (u) => u.stripeSubscriptionId === subscription.id
    );

    if (!user) return;

    const amount = invoiceObj.amount_paid / 100;

    // Activate subscription
    user.subscriptionStatus = "Active";
    saveUser(user);
    activateAutoProtectBilling(user.id, nextBillingDate);

    // Write payment ledger
    updateDb((ledgerDb) => {
      ledgerDb.payments.push({
        id: nanoid(),
        userId: user.id,
        stripePaymentIntentId: invoiceObj.payment_intent,
        stripeSubscriptionId: subscription.id,
        amount,
        status: "paid",
        createdAt: new Date().toISOString(),
      });

      ledgerDb.revenueSummary.totalRevenue += amount;
      ledgerDb.revenueSummary.subscriptionRevenue += amount;
    });

    audit({
      actorId: user.id,
      action: "PAYMENT_RECORDED",
      targetType: "User",
      targetId: user.id,
      meta: { amount },
    });
  }

  /* =====================================================
     REFUND ISSUED
  ====================================================== */

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    if (!charge.payment_intent) return;

    const refundAmount = charge.amount_refunded / 100;

    updateDb((ledgerDb) => {
      const payment = ledgerDb.payments.find(
        (p) => p.stripePaymentIntentId === charge.payment_intent
      );

      if (!payment) return;

      payment.status = "refunded";

      ledgerDb.refunds.push({
        id: nanoid(),
        userId: payment.userId,
        stripePaymentIntentId: charge.payment_intent,
        amount: refundAmount,
        createdAt: new Date().toISOString(),
      });

      ledgerDb.revenueSummary.totalRevenue -= refundAmount;
      ledgerDb.revenueSummary.subscriptionRevenue -= refundAmount;
      ledgerDb.revenueSummary.refundedAmount += refundAmount;
    });

    lockUserBilling(
      db.users.find(
        (u) => u.stripeSubscriptionId === charge.invoice?.subscription
      )?.id
    );

    audit({
      actorId: "system",
      action: "REFUND_RECORDED",
      targetType: "StripePayment",
      targetId: charge.payment_intent,
      meta: { refundAmount },
    });
  }

  /* =====================================================
     DISPUTE CREATED
  ====================================================== */

  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object;

    updateDb((ledgerDb) => {
      const payment = ledgerDb.payments.find(
        (p) => p.stripePaymentIntentId === dispute.payment_intent
      );

      if (!payment) return;

      payment.status = "disputed";

      ledgerDb.disputes.push({
        id: nanoid(),
        userId: payment.userId,
        stripePaymentIntentId: dispute.payment_intent,
        amount: dispute.amount / 100,
        status: dispute.status,
        createdAt: new Date().toISOString(),
      });

      ledgerDb.revenueSummary.disputedAmount +=
        dispute.amount / 100;
    });

    lockUserBilling(
      db.users.find(
        (u) => u.stripePaymentIntentId === dispute.payment_intent
      )?.id
    );

    audit({
      actorId: "system",
      action: "DISPUTE_CREATED",
      targetType: "StripeDispute",
      targetId: dispute.id,
    });
  }

  /* =====================================================
     DISPUTE CLOSED
  ====================================================== */

  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object;

    updateDb((ledgerDb) => {
      const record = ledgerDb.disputes.find(
        (d) => d.stripePaymentIntentId === dispute.payment_intent
      );
      if (record) record.status = dispute.status;
    });

    audit({
      actorId: "system",
      action: "DISPUTE_CLOSED",
      targetType: "StripeDispute",
      targetId: dispute.id,
      meta: { status: dispute.status },
    });
  }

  /* =====================================================
     SUBSCRIPTION CANCELLED
  ====================================================== */

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;

    const db2 = readDb();
    const user = db2.users.find(
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
    targetType: "User",
    targetId: user.id,
  });
}

module.exports = {
  cancelSubscription,
  handleStripeWebhook,
};
