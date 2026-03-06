// backend/src/routes/billing.routes.js
// =========================================================
// BILLING & SUBSCRIPTION CONTROL — ENTERPRISE v4 (SEALED)
// STRIPE-SAFE • ENTITLEMENT-ALIGNED • SESSION-AWARE
// QUIET MODE • NO STATE DRIFT • PLATFORM-STABLE
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");

const {
  createCheckoutSession,
  cancelSubscription,
} = require("../services/stripe.service");

const Stripe = require("stripe");

/* ================= STRIPE ================= */

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   PLAN DEFINITIONS (CANONICAL)
========================================================= */

const PLAN_TOOL_MAP = {
  individual_autodev: ["autodev-65"],
  individual_security: ["threat-feed"],
  enterprise: ["enterprise-monitor", "autodev-65", "threat-feed"],
};

const ALLOWED_PLANS = Object.keys(PLAN_TOOL_MAP);

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

function validatePlan(plan) {
  return ALLOWED_PLANS.includes(plan);
}

function findUser(db, userId) {
  return (db.users || []).find(
    (u) => String(u.id) === String(userId)
  );
}

/* =========================================================
   TOOL GRANT SYNC (PLAN-DRIVEN ONLY)
========================================================= */

function grantPlanTools(db, userId, planType) {
  const tools = PLAN_TOOL_MAP[planType] || [];

  db.toolGrants = (db.toolGrants || []).filter(
    (g) => String(g.userId) !== String(userId)
  );

  const grants = tools.map((toolId) => ({
    id: `plan_${toolId}_${Date.now()}`,
    toolId,
    userId,
    companyId: null,
    durationMinutes: null,
    expiresAt: "2100-01-01T00:00:00.000Z",
    approvedBy: "system_plan",
    approvedByRole: "system",
    createdAt: new Date().toISOString(),
  }));

  db.toolGrants.push(...grants);
}

function revokePlanTools(db, userId) {
  db.toolGrants = (db.toolGrants || []).filter(
    (g) => String(g.userId) !== String(userId)
  );
}

/* =========================================================
   GET CURRENT SUBSCRIPTION (SELF)
========================================================= */

router.get("/me", authRequired, (req, res) => {
  try {
    const db = readDb();
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    return res.json({
      ok: true,
      subscription: {
        status: user.subscriptionStatus || "inactive",
        plan: user.subscriptionTier || null,
        stripeCustomerId: user.stripeCustomerId || null,
        stripeSubscriptionId: user.stripeSubscriptionId || null,
      },
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   CREATE STRIPE CHECKOUT
========================================================= */

router.post("/checkout", authRequired, async (req, res) => {
  try {
    const db = readDb();
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const planType = clean(req.body?.type, 50);

    if (!validatePlan(planType)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid plan type",
      });
    }

    const successUrl =
      clean(req.body?.successUrl) ||
      process.env.STRIPE_SUCCESS_URL;

    const cancelUrl =
      clean(req.body?.cancelUrl) ||
      process.env.STRIPE_CANCEL_URL;

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({
        ok: false,
        error: "Missing success or cancel URL",
      });
    }

    const checkoutUrl = await createCheckoutSession({
      userId: user.id,
      type: planType,
      successUrl,
      cancelUrl,
    });

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "SUBSCRIPTION_CHECKOUT_STARTED",
      detail: { plan: planType },
    });

    return res.json({ ok: true, checkoutUrl });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   ADMIN ACTIVATE PLAN (NO STRIPE)
========================================================= */

router.post(
  "/admin/activate",
  authRequired,
  requireRole("admin"),
  (req, res) => {
    try {
      const db = readDb();

      const userId = clean(req.body?.userId);
      const planType = clean(req.body?.planType);

      if (!userId || !validatePlan(planType)) {
        return res.status(400).json({ ok: false });
      }

      const user = findUser(db, userId);
      if (!user) return res.status(404).json({ ok: false });

      user.subscriptionStatus = "active";
      user.subscriptionTier = normalize(planType);

      revokePlanTools(db, userId);
      grantPlanTools(db, userId, planType);

      writeDb(db);

      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "ADMIN_PLAN_ACTIVATED",
        detail: { userId, planType },
      });

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ ok: false });
    }
  }
);

/* =========================================================
   CANCEL SUBSCRIPTION (STRIPE OR MANUAL)
========================================================= */

router.post("/cancel", authRequired, async (req, res) => {
  try {
    const db = readDb();
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    if (user.stripeSubscriptionId) {
      await cancelSubscription(user.id);
    }

    user.subscriptionStatus = "locked";
    user.subscriptionTier = null;
    user.stripeSubscriptionId = null;

    revokePlanTools(db, user.id);
    writeDb(db);

    // 🔒 Kill all sessions immediately
    sessionAdapter.revokeAllUserSessions(user.id);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "SUBSCRIPTION_CANCELLED",
    });

    return res.json({
      ok: true,
      message: "Subscription cancelled and access revoked",
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
