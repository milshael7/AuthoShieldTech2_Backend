// backend/src/services/stripe.service.js
// Stripe Service — Enterprise Financial Integrity Layer
// Invoice Synced • Refund Safe • Dispute Safe • Revenue Reconciled

const Stripe = require("stripe");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const {
  createInvoice,
  createRefundInvoice,
} = require("./invoice.service");

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
     SUBSCRIPTION PAYMENT SUCCEEDED
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

    if (user) {
      user.subscriptionStatus = "Active";
      saveUser(user);
      activateAutoProtectBilling(user.id, nextBillingDate);

      createInvoice({
        userId: user.id,
        type: "subscription",
        stripeSubscriptionId: subscription.id,
        stripePaymentIntentId: invoiceObj.payment_intent,
        amountPaidCents: invoiceObj.amount_paid,
        meta: { phase: "recurring" },
      });
    }
  }

  /* =====================================================
     REFUND ISSUED (FULL OR PARTIAL)
  ====================================================== */

  if (event.type === "charge.refunded") {
    const charge = event.data.object;

    if (!charge.payment_intent) return;

    const db2 = readDb();
    const user = db2.users.find(
      (u) => u.stripePaymentIntentId === charge.payment_intent
    );

    if (!user) return;

    createRefundInvoice({
      userId: user.id,
      stripePaymentIntentId: charge.payment_intent,
      amountRefundedCents: charge.amount_refunded,
      reason: "stripe_refund",
    });

    lockUserBilling(user.id);

    audit({
      actorId: user.id,
      action: "PAYMENT_REFUNDED",
      targetType: "User",
      targetId: user.id,
    });
  }

  /* =====================================================
     DISPUTE CREATED (CHARGEBACK)
  ====================================================== */

  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object;

    if (!dispute.payment_intent) return;

    const db2 = readDb();
    const user = db2.users.find(
      (u) => u.stripePaymentIntentId === dispute.payment_intent
    );

    if (!user) return;

    lockUserBilling(user.id);

    audit({
      actorId: user.id,
      action: "PAYMENT_DISPUTE_CREATED",
      targetType: "User",
      targetId: user.id,
    });
  }

  /* =====================================================
     DISPUTE CLOSED (WON OR LOST)
  ====================================================== */

  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object;

    audit({
      actorId: "system",
      action: "PAYMENT_DISPUTE_CLOSED",
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
