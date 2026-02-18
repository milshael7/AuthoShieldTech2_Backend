// backend/src/services/stripe.service.js
// Stripe Service — Production Hardened • Subscription Activation Engine

const Stripe = require("stripe");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { audit } = require("../lib/audit");

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

function activateIndividual(userId) {
  const user = users.findById(userId);
  if (!user) return;

  user.subscriptionStatus = users.SUBSCRIPTION.ACTIVE;
  user.autoDevEnabled = true;

  saveUser(user);

  audit({
    actorId: userId,
    action: "INDIVIDUAL_SUBSCRIPTION_ACTIVATED",
    targetType: "User",
    targetId: userId,
  });
}

function activateCompany(companyId, planType, userId) {
  if (!companyId) return;

  const updated = companies.upgradeCompany(
    companyId,
    planType,
    userId
  );

  audit({
    actorId: userId,
    action: "COMPANY_SUBSCRIPTION_ACTIVATED",
    targetType: "Company",
    targetId: companyId,
    metadata: { planType },
  });

  return updated;
}

function deactivateSubscription(userId) {
  const user = users.findById(userId);
  if (!user) return;

  user.subscriptionStatus = users.SUBSCRIPTION.PAST_DUE;
  user.autoDevEnabled = false;

  saveUser(user);

  audit({
    actorId: userId,
    action: "SUBSCRIPTION_DEACTIVATED",
    targetType: "User",
    targetId: userId,
  });
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
   WEBHOOK HANDLER
========================================================= */

async function handleStripeWebhook(event) {

  switch (event.type) {

    case "checkout.session.completed": {
      const session = event.data.object;

      const userId = session.metadata?.userId;
      const planType = session.metadata?.planType;
      const companyId = session.metadata?.companyId || null;

      if (!userId || !planType) return;

      if (planType === "individual_autodev") {
        activateIndividual(userId);
      } else {
        activateCompany(companyId, planType, userId);
      }

      break;
    }

    case "invoice.payment_failed": {
      const subscription = event.data.object;
      const customerEmail = subscription.customer_email;

      if (!customerEmail) return;

      const user = users.findByEmail(customerEmail);
      if (!user) return;

      deactivateSubscription(user.id);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerEmail = subscription.customer_email;

      if (!customerEmail) return;

      const user = users.findByEmail(customerEmail);
      if (!user) return;

      deactivateSubscription(user.id);
      break;
    }

    default:
      break;
  }
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  createCheckoutSession,
  handleStripeWebhook,
};
