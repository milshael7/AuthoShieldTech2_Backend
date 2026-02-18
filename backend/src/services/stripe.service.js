// backend/src/services/stripe.service.js
// Stripe Service — Production Ready • Tier Integrated • Portal Enabled

const Stripe = require("stripe");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   PRICE MAP (MATCH STRIPE DASHBOARD)
========================================================= */

const PRICE_MAP = {
  individual_autodev: process.env.STRIPE_PRICE_AUTODEV,
  micro: process.env.STRIPE_PRICE_MICRO,
  small: process.env.STRIPE_PRICE_SMALL,
  mid: process.env.STRIPE_PRICE_MID,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

/* =========================================================
   INTERNAL HELPERS
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
   CREATE CHECKOUT SESSION
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
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    customer_email: user.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      userId: user.id,
      planType: type,
      companyId: user.companyId || "",
    },
  });

  audit({
    actorId: user.id,
    action: "STRIPE_CHECKOUT_CREATED",
    targetType: "Billing",
    targetId: session.id,
    metadata: { planType: type },
  });

  return session.url;
}

/* =========================================================
   CREATE CUSTOMER PORTAL SESSION
========================================================= */

async function createCustomerPortalSession({
  userId,
  returnUrl,
}) {
  const user = users.findById(userId);
  if (!user) throw new Error("User not found");

  if (!user.stripeCustomerId) {
    throw new Error("No Stripe customer linked");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: returnUrl,
  });

  audit({
    actorId: user.id,
    action: "STRIPE_PORTAL_OPENED",
    targetType: "Billing",
    targetId: user.stripeCustomerId,
  });

  return session.url;
}

/* =========================================================
   ACTIVATE SUBSCRIPTION (Webhook Triggered)
========================================================= */

async function activateSubscription({
  userId,
  planType,
  subscriptionId,
}) {
  const user = users.findById(userId);
  if (!user) return;

  const subscription = await stripe.subscriptions.retrieve(
    subscriptionId
  );

  user.subscriptionStatus = "Active";
  user.stripeCustomerId = subscription.customer;
  user.stripeSubscriptionId = subscriptionId;

  saveUser(user);

  // If company plan upgrade
  if (user.companyId && PRICE_MAP[planType]) {
    companies.upgradeCompany(
      user.companyId,
      planType,
      user.id
    );
  }

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_ACTIVATED",
    targetType: "User",
    targetId: user.id,
    metadata: { planType },
  });
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

  user.subscriptionStatus = "Cancelled";
  saveUser(user);

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_CANCELLED",
    targetType: "User",
    targetId: user.id,
  });
}

module.exports = {
  createCheckoutSession,
  createCustomerPortalSession,
  activateSubscription,
  cancelSubscription,
};
