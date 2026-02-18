// backend/src/routes/stripe.webhook.routes.js
// Stripe Webhook — Subscription Activation Engine

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const { activateSubscription } = require("../services/stripe.service");

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
   RAW BODY REQUIRED FOR STRIPE SIGNATURE
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
      console.error("Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    /* =========================================================
       HANDLE EVENTS
    ========================================================= */

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "subscription") {
        const userId = session.metadata?.userId;
        const planType = session.metadata?.planType;
        const subscriptionId = session.subscription;

        if (userId && planType && subscriptionId) {
          activateSubscription({
            userId,
            planType,
            subscriptionId,
          });
        }
      }
    }

    /* ========================================================= */

    return res.json({ received: true });
  }
);

module.exports = router;
