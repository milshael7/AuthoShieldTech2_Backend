// backend/src/routes/stripe.webhook.routes.js
// Phase 25 — Enterprise Stripe Webhook Security Layer
// Signature Verified • Replay Protected • Idempotent • Audited

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const { handleStripeWebhook } = require("../services/stripe.service");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

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
   CONFIG
========================================================= */

const MAX_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// Only allow specific Stripe events
const ALLOWED_EVENT_TYPES = new Set([
  "invoice.payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.subscription.deleted",
]);

/*
IMPORTANT:
Raw body must be provided from server.js
Do NOT use express.json() here
*/

/* =========================================================
   WEBHOOK ENDPOINT
========================================================= */

router.post("/", async (req, res) => {
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_REJECTED_MISSING_SIGNATURE",
    });

    return res.status(400).send("Missing stripe-signature header");
  }

  // Content-Type validation
  if (req.headers["content-type"] !== "application/json") {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_REJECTED_INVALID_CONTENT_TYPE",
      detail: { contentType: req.headers["content-type"] },
    });

    return res.status(400).send("Invalid content-type");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_INVALID_SIGNATURE",
      detail: { message: err.message },
    });

    return res.status(400).send("Webhook signature verification failed");
  }

  /* =========================================================
     REPLAY ATTACK PROTECTION
  ========================================================== */

  const timestamp = event.created;
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_TOLERANCE_SECONDS) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_REPLAY_BLOCKED",
      detail: { eventId: event.id },
    });

    return res.status(400).send("Event outside allowed time window");
  }

  /* =========================================================
     EVENT TYPE ALLOW LIST
  ========================================================== */

  if (!ALLOWED_EVENT_TYPES.has(event.type)) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_EVENT_IGNORED",
      detail: { eventType: event.type },
    });

    return res.json({ ignored: true });
  }

  /* =========================================================
     IDEMPOTENCY PRE-CHECK
  ========================================================== */

  const db = readDb();
  if (db.processedStripeEvents?.includes(event.id)) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_DUPLICATE_IGNORED",
      detail: { eventId: event.id },
    });

    return res.json({ duplicate: true });
  }

  try {
    await handleStripeWebhook(event);

    updateDb((db2) => {
      if (!Array.isArray(db2.processedStripeEvents))
        db2.processedStripeEvents = [];

      db2.processedStripeEvents.push(event.id);
      return db2;
    });

    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_PROCESSED",
      detail: { eventId: event.id, type: event.type },
    });

  } catch (err) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_PROCESSING_FAILED",
      detail: { eventId: event.id, error: err.message },
    });

    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed",
    });
  }

  return res.json({ received: true });
});

module.exports = router;
