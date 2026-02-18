// backend/src/services/stripe.service.js
// Stripe Service — Production Ready • Persistent • Webhook Compatible

const Stripe = require("stripe");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { audit } = require("../lib/audit");

/* =========================================================
   ENV VALIDATION
========================================================= */

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   PRICE MAP (MUST MATCH STRIPE DASHBOARD)
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

async function getOrCreateCustomer(user) {
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: {
      userId: user.id,
    },
  });

  user.stripeCustomerId = customer.id;
  saveUser(user);

  return customer.id;
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

  const customerId = await getOrCreateCustomer(user);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
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
   ACTIVATE SUBSCRIPTION (CALLED FROM WEBHOOK)
========================================================= */

function activateSubscription({ userId, planType, subscriptionId }) {
  const user = users.findById(userId);
  if (!user) return;

  user.subscriptionStatus = users.SUBSCRIPTION.ACTIVE;
  user.stripeSubscriptionId = subscriptionId;

  saveUser(user);

  // If company plan → upgrade tier
  if (user.companyId && planType !== "individual_autodev") {
    companies.upgradeCompany(user.companyId, planType, user.id);
  }

  audit({
    actorId: user.id,
    action: "STRIPE_SUBSCRIPTION_ACTIVATED",
    targetType: "Billing",
    targetId: subscriptionId,
    metadata: { planType },
  });
}

module.exports = {
  createCheckoutSession,
  activateSubscription,
};
