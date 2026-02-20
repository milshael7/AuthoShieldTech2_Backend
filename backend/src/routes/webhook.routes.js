// backend/src/routes/webhook.routes.js
// Stripe Webhook Endpoint — Signature Verified • Raw Body Required • Secure

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
⚠️ IMPORTANT:
This route MUST use express.raw()
Do NOT use express.json() for this endpoint
*/

router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      return res.status(400).send("Missing Stripe signature");
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await handleStripeWebhook(event);
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

module.exports = router;
