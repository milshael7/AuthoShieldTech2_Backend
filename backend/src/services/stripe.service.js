// backend/src/services/stripe.service.js
// Stripe Service — Enterprise Hardened • Payment Authoritative • Webhook Safe

const Stripe = require("stripe");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { markScanPaid, processScan, getScan } = require("./scan.service");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   SUBSCRIPTION PRICE MAP
========================================================= */

const PRICE_MAP = {
  individual_autodev: process.env.STRIPE_PRICE_AUTODEV,
  micro: process.env.STRIPE_PRICE_MICRO,
  small: process.env.STRIPE_PRICE_SMALL,
  mid: process.env.STRIPE_PRICE_MID,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

/* =========================================================
   INTERNAL SAVE
========================================================= */

function saveUser(updatedUser) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === updatedUser.id);
  if (idx !== -1) {
    db.users[idx] = updatedUser;
    writeDb(db);
  }
}

/* =========================================================
   SUBSCRIPTION CHECKOUT
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
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      userId: user.id,
      planType: type,
    },
  });

  audit({
    actorId: user.id,
    action: "STRIPE_SUBSCRIPTION_CHECKOUT_CREATED",
    targetType: "Billing",
    targetId: session.id,
  });

  return session.url;
}

/* =========================================================
   TOOL ONE-TIME CHECKOUT (SERVER AUTHORITATIVE)
========================================================= */

async function createToolCheckoutSession({
  scanId,
  amount,
  successUrl,
  cancelUrl,
}) {
  const scan = getScan(scanId);
  if (!scan) throw new Error("Scan not found");

  if (amount !== scan.finalPrice) {
    throw new Error("Price mismatch");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: scan.toolName,
          },
          unit_amount: amount * 100,
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      scanId,
      type: "tool_payment",
    },
  });

  audit({
    actorId: "system",
    action: "STRIPE_TOOL_CHECKOUT_CREATED",
    targetType: "Scan",
    targetId: scanId,
  });

  return session.url;
}

/* =========================================================
   ACTIVATE SUBSCRIPTION
========================================================= */

async function activateSubscription({
  userId,
  planType,
  subscriptionId,
}) {
  const user = users.findById(userId);
  if (!user) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  user.subscriptionStatus = "Active";
  user.stripeCustomerId = subscription.customer;
  user.stripeSubscriptionId = subscriptionId;

  saveUser(user);

  if (user.companyId && PRICE_MAP[planType]) {
    companies.upgradeCompany(user.companyId, planType, user.id);
  }

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_ACTIVATED",
    targetType: "User",
    targetId: user.id,
  });
}

/* =========================================================
   WEBHOOK HANDLER
========================================================= */

async function handleStripeWebhook(event) {
  const db = readDb();

  if (!Array.isArray(db.processedStripeEvents)) {
    db.processedStripeEvents = [];
  }

  if (db.processedStripeEvents.includes(event.id)) {
    return;
  }

  db.processedStripeEvents.push(event.id);
  writeDb(db);

  /* ---------------- CHECKOUT COMPLETED ---------------- */

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    /* ---- Subscription ---- */

    if (session.mode === "subscription") {
      const userId = session.metadata?.userId;
      const planType = session.metadata?.planType;
      const subscriptionId = session.subscription;

      if (userId && planType && subscriptionId) {
        await activateSubscription({
          userId,
          planType,
          subscriptionId,
        });
      }
    }

    /* ---- Tool Payment ---- */

    if (
      session.mode === "payment" &&
      session.metadata?.type === "tool_payment"
    ) {
      const scanId = session.metadata?.scanId;
      if (!scanId) return;

      const scan = getScan(scanId);
      if (!scan) return;

      /* 🔒 Extra payment validation */
      const paidAmount = session.amount_total / 100;

      if (paidAmount !== scan.finalPrice) {
        audit({
          actorId: "system",
          action: "PAYMENT_AMOUNT_MISMATCH",
          targetType: "Scan",
          targetId: scanId,
        });
        return;
      }

      /* 🔥 Save paymentIntent ID */
      updateDb((db2) => {
        const s = db2.scans?.find((x) => x.id === scanId);
        if (s) {
          s.stripePaymentIntentId = session.payment_intent;
        }
      });

      markScanPaid(scanId);
      processScan(scanId);

      audit({
        actorId: "system",
        action: "TOOL_PAYMENT_COMPLETED",
        targetType: "Scan",
        targetId: scanId,
      });
    }
  }

  /* ---------------- SUBSCRIPTION STATUS SYNC ---------------- */

  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object;
    await syncSubscriptionStatus(subscription.id, subscription.status);
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    await syncSubscriptionStatus(invoice.subscription, "past_due");
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    await syncSubscriptionStatus(invoice.subscription, "active");
  }
}

/* =========================================================
   SYNC SUBSCRIPTION STATUS
========================================================= */

async function syncSubscriptionStatus(subscriptionId, stripeStatus) {
  if (!subscriptionId) return;

  const db = readDb();
  const user = db.users.find(
    (u) => u.stripeSubscriptionId === subscriptionId
  );

  if (!user) return;

  let mappedStatus = "Inactive";

  switch (stripeStatus) {
    case "active":
    case "trialing":
      mappedStatus = "Active";
      break;
    case "past_due":
      mappedStatus = "PastDue";
      break;
    case "canceled":
    case "unpaid":
      mappedStatus = "Locked";
      break;
  }

  user.subscriptionStatus = mappedStatus;
  saveUser(user);
}

/* =========================================================
   CANCEL SUBSCRIPTION
========================================================= */

async function cancelSubscription(userId) {
  const user = users.findById(userId);
  if (!user?.stripeSubscriptionId) {
    throw new Error("No active subscription");
  }

  await stripe.subscriptions.cancel(user.stripeSubscriptionId);

  user.subscriptionStatus = "Locked";
  saveUser(user);

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_CANCELLED",
    targetType: "User",
    targetId: user.id,
  });
}

module.exports = {
  createCheckoutSession,
  createToolCheckoutSession,
  activateSubscription,
  cancelSubscription,
  handleStripeWebhook,
};
