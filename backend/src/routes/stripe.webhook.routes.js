// backend/src/routes/stripe.webhook.routes.js
// Stripe Webhook — Production Safe • Idempotent • Signature Verified

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const { handleStripeWebhook } = require("../services/stripe.service");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error("STRIPE_WEBHOOK_SECRET missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/*
IMPORTANT:
Raw body is handled in server.js
Do NOT use express.json() here.
Do NOT use express.raw() here.
*/

router.post("/", async (req, res) => {
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE] Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeWebhook(event);
  } catch (err) {
    console.error("[STRIPE] Webhook processing failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed",
    });
  }

  return res.json({ received: true });
});

module.exports = router;
