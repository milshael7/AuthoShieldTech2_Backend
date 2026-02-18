// backend/src/routes/stripe.webhook.routes.js
// Stripe Webhook — Production Hardened • Signature Verified • Subscription Engine

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

/* =========================================================
   IMPORTANT:
   This route MUST use raw body
========================================================= */

router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[STRIPE] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await handleStripeWebhook(event);
    } catch (err) {
      console.error("[STRIPE] Webhook handler error:", err);
      return res.status(500).json({
        ok: false,
        error: "Webhook processing failed",
      });
    }

    return res.json({ received: true });
  }
);

module.exports = router;
