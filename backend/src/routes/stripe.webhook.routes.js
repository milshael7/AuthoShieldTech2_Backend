// Phase 38 — Immutable Stripe Revenue Core
// Signature Verified • Replay Protected • Idempotent • Memory Bounded • Livemode Enforced • Audited

const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const { handleStripeWebhook } = require("../services/stripe.service");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

if (!process.env.STRIPE_SECRET_KEY)
  throw new Error("STRIPE_SECRET_KEY missing");

if (!process.env.STRIPE_WEBHOOK_SECRET)
  throw new Error("STRIPE_WEBHOOK_SECRET missing");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   CONFIG
========================================================= */

const MAX_TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_STORED_EVENT_IDS = 5000;

const ALLOWED_EVENT_TYPES = new Set([
  "invoice.payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.subscription.deleted",
]);

/* =========================================================
   WEBHOOK
========================================================= */

router.post("/", async (req, res) => {

  const signature = req.headers["stripe-signature"];

  if (!signature) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_REJECTED_NO_SIGNATURE",
    });
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
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_INVALID_SIGNATURE",
      detail: { message: err.message },
    });
    return res.status(400).send("Invalid signature");
  }

  /* =========================================================
     LIVE MODE ENFORCEMENT
  ========================================================== */

  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && event.livemode !== true) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_TEST_EVENT_BLOCKED",
      detail: { eventId: event.id },
    });
    return res.status(400).send("Test event blocked in production");
  }

  /* =========================================================
     TIMESTAMP REPLAY PROTECTION
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
    return res.status(400).send("Replay window exceeded");
  }

  /* =========================================================
     ALLOW LIST
  ========================================================== */

  if (!ALLOWED_EVENT_TYPES.has(event.type)) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_IGNORED_EVENT",
      detail: { type: event.type },
    });
    return res.json({ ignored: true });
  }

  /* =========================================================
     IDEMPOTENCY
  ========================================================== */

  const db = readDb();
  if (!Array.isArray(db.processedStripeEvents))
    db.processedStripeEvents = [];

  if (db.processedStripeEvents.includes(event.id)) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_DUPLICATE_IGNORED",
      detail: { eventId: event.id },
    });
    return res.json({ duplicate: true });
  }

  /* =========================================================
     PROCESS EVENT
  ========================================================== */

  try {
    await handleStripeWebhook(event);

    updateDb((db2) => {

      if (!Array.isArray(db2.processedStripeEvents))
        db2.processedStripeEvents = [];

      db2.processedStripeEvents.push(event.id);

      // Memory Bound Protection
      if (db2.processedStripeEvents.length > MAX_STORED_EVENT_IDS) {
        db2.processedStripeEvents =
          db2.processedStripeEvents.slice(-MAX_STORED_EVENT_IDS);
      }

      return db2;
    });

    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_PROCESSED",
      detail: {
        eventId: event.id,
        type: event.type,
      },
    });

  } catch (err) {
    writeAudit({
      actor: "stripe_webhook",
      role: "system",
      action: "WEBHOOK_PROCESSING_FAILED",
      detail: {
        eventId: event.id,
        error: err.message,
      },
    });

    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed",
    });
  }

  return res.json({ received: true });
});

module.exports = router;
