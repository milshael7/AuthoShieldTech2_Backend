// backend/src/services/stripe.service.js
// Stripe Service — Production Ready • Tier Integrated

const Stripe = require("stripe");
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
   PRICE MAP (MATCH TO STRIPE DASHBOARD PRICE IDS)
========================================================= */

const PRICE_MAP = {
  individual_autodev: process.env.STRIPE_PRICE_AUTODEV,
  micro: process.env.STRIPE_PRICE_MICRO,
  small: process.env.STRIPE_PRICE_SMALL,
  mid: process.env.STRIPE_PRICE_MID,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

/* =========================================================
   CREATE CHECKOUT SESSION
========================================================= */

async function createCheckoutSession({
  userId,
  type, // "individual_autodev" OR company tier
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

module.exports = {
  createCheckoutSession,
};
