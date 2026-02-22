// backend/src/services/stripe.service.js
// Dev Mode Stripe Wrapper
// Backend never crashes if Stripe is not configured

let stripe = null;
let stripeEnabled = false;

try {
  if (process.env.STRIPE_SECRET_KEY) {
    const Stripe = require("stripe");
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    });
    stripeEnabled = true;
    console.log("✅ Stripe enabled");
  } else {
    console.log("⚠ Stripe disabled (no STRIPE_SECRET_KEY)");
  }
} catch (err) {
  console.log("⚠ Stripe module unavailable:", err.message);
  stripe = null;
  stripeEnabled = false;
}

/* =========================================================
   SAFE GUARD
========================================================= */

function requireStripe() {
  if (!stripeEnabled || !stripe) {
    const error = new Error("Stripe not configured");
    error.status = 503;
    throw error;
  }
  return stripe;
}

/* =========================================================
   SAFE WEBHOOK
========================================================= */

async function handleStripeWebhook(event) {
  if (!stripeEnabled) {
    console.log("Webhook received but Stripe disabled");
    return;
  }

  console.log("Stripe event:", event.type);
}

/* =========================================================
   SAFE CANCEL
========================================================= */

async function cancelSubscription(userId) {
  if (!stripeEnabled) {
    const error = new Error("Stripe not configured");
    error.status = 503;
    throw error;
  }

  const client = requireStripe();
  return client.subscriptions.cancel(userId);
}

module.exports = {
  cancelSubscription,
  handleStripeWebhook,
};
