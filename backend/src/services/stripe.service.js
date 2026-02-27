// backend/src/services/stripe.service.js
// Revenue → Entitlement Enforcement Engine v2
// Webhook Verified • Ledger Safe • Session Safe • Tier Synced

const Stripe = require("stripe");
const crypto = require("crypto");
const sessionAdapter = require("../lib/sessionAdapter");
const users = require("../users/user.service");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { nanoid } = require("nanoid");

if (!process.env.STRIPE_SECRET_KEY)
  throw new Error("STRIPE_SECRET_KEY missing");

if (!process.env.STRIPE_WEBHOOK_SECRET)
  throw new Error("STRIPE_WEBHOOK_SECRET missing");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* ========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeLedgerHash(entry) {
  return sha256(JSON.stringify(entry));
}

function clampRevenue(n) {
  return Math.max(0, Number(n) || 0);
}

function ensureFinancialArrays(db) {
  if (!Array.isArray(db.payments)) db.payments = [];
  if (!Array.isArray(db.refunds)) db.refunds = [];
  if (!Array.isArray(db.disputes)) db.disputes = [];
  if (!Array.isArray(db.toolGrants)) db.toolGrants = [];

  if (!db.revenueSummary) {
    db.revenueSummary = {
      totalRevenue: 0,
      subscriptionRevenue: 0,
      autoprotekRevenue: 0,
      toolRevenue: 0,
      refundedAmount: 0,
      disputedAmount: 0,
    };
  }
}

function saveUser(updatedUser) {
  const db = readDb();
  const idx = db.users.findIndex((u) => String(u.id) === String(updatedUser.id));
  if (idx !== -1) {
    db.users[idx] = updatedUser;
    writeDb(db);
  }
}

function purgeToolGrantsForUser(userId) {
  updateDb((db) => {
    db.toolGrants = db.toolGrants.filter(
      (g) => String(g.userId) !== String(userId)
    );
    return db;
  });
}

function lockUser(user) {
  user.subscriptionStatus = "Locked";
  saveUser(user);

  purgeToolGrantsForUser(user.id);

  // 🔥 Immediately kill sessions
  sessionAdapter.revokeAllUserSessions(user.id);

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_LOCKED",
  });
}

function activateUser(user, nextBillingDate, planType = "paid") {
  user.subscriptionStatus = "Active";
  user.subscriptionTier = planType;
  saveUser(user);

  updateDb((db) => {
    db.autoprotek = db.autoprotek || { users: {} };
    db.autoprotek.users[user.id] = {
      status: "ACTIVE",
      nextBillingDate,
    };
    return db;
  });

  audit({
    actorId: user.id,
    action: "SUBSCRIPTION_ACTIVATED",
    metadata: { planType },
  });
}

/* =========================================================
   WEBHOOK VERIFICATION
========================================================= */

function verifyStripeWebhook(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

/* =========================================================
   WEBHOOK HANDLER
========================================================= */

async function handleStripeWebhook(event) {

  if (event.type === "invoice.payment_succeeded") {

    const invoiceObj = event.data.object;

    const subscription = await stripe.subscriptions.retrieve(
      invoiceObj.subscription
    );

    const db = readDb();
    ensureFinancialArrays(db);

    const user = db.users.find(
      (u) => u.stripeSubscriptionId === subscription.id
    );
    if (!user) return;

    const amount = invoiceObj.amount_paid / 100;

    if (
      db.payments.find(
        (p) => p.stripePaymentIntentId === invoiceObj.payment_intent
      )
    ) return;

    const paymentEntry = {
      id: nanoid(),
      userId: user.id,
      stripePaymentIntentId: invoiceObj.payment_intent,
      stripeSubscriptionId: subscription.id,
      amount,
      status: "paid",
      createdAt: new Date().toISOString(),
    };

    paymentEntry.hash = computeLedgerHash(paymentEntry);

    updateDb((ledgerDb) => {
      ensureFinancialArrays(ledgerDb);

      ledgerDb.payments.push(paymentEntry);

      ledgerDb.revenueSummary.totalRevenue =
        clampRevenue(ledgerDb.revenueSummary.totalRevenue + amount);

      ledgerDb.revenueSummary.subscriptionRevenue =
        clampRevenue(ledgerDb.revenueSummary.subscriptionRevenue + amount);

      return ledgerDb;
    });

    activateUser(
      user,
      new Date(subscription.current_period_end * 1000).toISOString(),
      subscription.metadata?.planType || "paid"
    );
  }

  if (event.type === "charge.refunded") {

    const charge = event.data.object;
    if (!charge.payment_intent) return;

    const db = readDb();
    const payment = db.payments.find(
      (p) => p.stripePaymentIntentId === charge.payment_intent
    );
    if (!payment) return;

    const user = db.users.find((u) => u.id === payment.userId);
    if (!user) return;

    lockUser(user);

    updateDb((ledgerDb) => {
      ensureFinancialArrays(ledgerDb);

      const refundAmount = charge.amount_refunded / 100;

      ledgerDb.revenueSummary.totalRevenue =
        clampRevenue(ledgerDb.revenueSummary.totalRevenue - refundAmount);

      ledgerDb.revenueSummary.subscriptionRevenue =
        clampRevenue(ledgerDb.revenueSummary.subscriptionRevenue - refundAmount);

      ledgerDb.revenueSummary.refundedAmount += refundAmount;

      return ledgerDb;
    });
  }

  if (event.type === "charge.dispute.created") {

    const dispute = event.data.object;
    const db = readDb();

    const payment = db.payments.find(
      (p) => p.stripePaymentIntentId === dispute.payment_intent
    );
    if (!payment) return;

    const user = db.users.find((u) => u.id === payment.userId);
    if (!user) return;

    lockUser(user);
  }

  if (event.type === "customer.subscription.deleted") {

    const subscription = event.data.object;
    const db = readDb();

    const user = db.users.find(
      (u) => u.stripeSubscriptionId === subscription.id
    );

    if (user) lockUser(user);
  }
}

module.exports = {
  cancelSubscription,
  handleStripeWebhook,
  verifyStripeWebhook,
};
