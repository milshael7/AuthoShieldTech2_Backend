// backend/src/services/stripe.service.js
// Stripe Service — Enterprise Revenue Hardened • Invoice Authoritative • Idempotent Safe

const Stripe = require("stripe");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { createInvoice } = require("./invoice.service");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   PRICE MAP
========================================================= */

const PRICE_MAP = {
  individual_autodev: process.env.STRIPE_PRICE_AUTODEV,
  micro: process.env.STRIPE_PRICE_MICRO,
  small: process.env.STRIPE_PRICE_SMALL,
  mid: process.env.STRIPE_PRICE_MID,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

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
   AUTOPROTECT SYNC
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

function markAutoProtectPastDue(userId) {
  updateDb((db) => {
    if (!db.autoprotek?.users?.[userId]) return;
    db.autoprotek.users[userId].subscriptionStatus = "PAST_DUE";
    db.autoprotek.users[userId].status = "INACTIVE";
  });
}

function lockAutoProtect(userId) {
  updateDb((db) => {
    if (!db.autoprotek?.users?.[userId]) return;
    db.autoprotek.users[userId].subscriptionStatus = "LOCKED";
    db.autoprotek.users[userId].status = "INACTIVE";
  });
}

/* =========================================================
   CHECKOUT SESSION
========================================================= */

async function createCheckoutSession({
  userId,
  type,
  successUrl,
  cancelUrl,
}) {
  const user = users.findById(userId);
  if (!user) throw new Error("User not found");

  const priceId = PRICE_MAP[type];
  if (!priceId) throw new Error("Invalid plan type");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      userId: user.id,
      planType: type,
    },
  });

  audit({
    actorId: user.id,
    action: "STRIPE_SUBSCRIPTION_CHECKOUT_CREATED",
    targetType: "Billing",
    targetId: session.id,
  });

  return session.url;
}

/* =========================================================
   ACTIVATE SUBSCRIPTION
========================================================= */

async function activateSubscription({
  userId,
  planType,
  subscriptionId,
}) {
  const user = users.findById(userId);
  if (!user) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const nextBillingDate = new Date(
    subscription.current_period_end * 1000
  ).toISOString();

  user.subscriptionStatus = "Active";
  user.stripeCustomerId = subscription.customer;
  user.stripeSubscriptionId = subscriptionId;

  saveUser(user);
  activateAutoProtectBilling(user.id, nextBillingDate);

  if (user.companyId && PRICE_MAP[planType]) {
    companies.upgradeCompany(user.companyId, planType, user.id);
  }

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_ACTIVATED",
    targetType: "User",
    targetId: user.id,
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
     CHECKOUT COMPLETED (INITIAL SUBSCRIPTION)
  ====================================================== */

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.mode === "subscription") {
      const userId = session.metadata?.userId;
      const planType = session.metadata?.planType;
      const subscriptionId = session.subscription;

      if (userId && subscriptionId) {
        await activateSubscription({
          userId,
          planType,
          subscriptionId,
        });

        // 🔥 Create initial invoice (first payment)
        if (session.amount_total) {
          createInvoice({
            userId,
            type: "subscription",
            stripeSessionId: session.id,
            stripeSubscriptionId: subscriptionId,
            stripePaymentIntentId: session.payment_intent,
            amountPaidCents: session.amount_total,
            meta: {
              phase: "initial_subscription_payment",
              planType,
            },
          });
        }
      }
    }
  }

  /* =====================================================
     RECURRING SUBSCRIPTION PAYMENT
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
        meta: {
          phase: "recurring_subscription",
        },
      });
    }
  }

  /* =====================================================
     PAYMENT FAILED
  ====================================================== */

  if (event.type === "invoice.payment_failed") {
    const invoiceObj = event.data.object;

    const db2 = readDb();
    const user = db2.users.find(
      (u) => u.stripeSubscriptionId === invoiceObj.subscription
    );

    if (user) {
      user.subscriptionStatus = "PastDue";
      saveUser(user);
      markAutoProtectPastDue(user.id);
    }
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
      lockAutoProtect(user.id);
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
  lockAutoProtect(user.id);

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_CANCELLED",
    targetType: "User",
    targetId: user.id,
  });
}

module.exports = {
  createCheckoutSession,
  activateSubscription,
  cancelSubscription,
  handleStripeWebhook,
};
