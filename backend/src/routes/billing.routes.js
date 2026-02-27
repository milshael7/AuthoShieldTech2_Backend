// backend/src/routes/billing.routes.js
// Billing & Subscription Control — Enterprise Hardened v2
// Stripe Safe • Entitlement Synced • Revenue Protected • Session Safe

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");

const {
  grantTool,
  revokeTool,
  revokeAllTools
} = require("../lib/entitlement.engine");

const {
  createCheckoutSession,
  cancelSubscription,
} = require("../services/stripe.service");

const Stripe = require("stripe");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

/* =========================================================
   PLAN CONTROL
========================================================= */

const PLAN_TOOL_MAP = {
  individual_autodev: ["autodev-65"],
  individual_security: ["threat-feed"],
  enterprise: ["enterprise-monitor", "autodev-65", "threat-feed"]
};

const ALLOWED_PLANS = Object.keys(PLAN_TOOL_MAP);

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ ok: false, error: "Invalid auth context" });
    return null;
  }
  return req.user;
}

function saveUser(updatedUser) {
  const db = readDb();
  const idx = db.users.findIndex((u) => String(u.id) === String(updatedUser.id));
  if (idx !== -1) {
    db.users[idx] = updatedUser;
    writeDb(db);
  }
}

function validatePlan(planType) {
  return ALLOWED_PLANS.includes(planType);
}

function grantPlanTools(userId, planType) {
  const tools = PLAN_TOOL_MAP[planType] || [];
  tools.forEach(toolId => grantTool(userId, toolId));
}

function revokePlanTools(userId) {
  revokeAllTools(userId);
}

/* =========================================================
   GET CURRENT SUBSCRIPTION
========================================================= */

router.get("/me", authRequired, (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const dbUser = users.findById(user.id);
    if (!dbUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    let companyPlan = null;

    if (dbUser.companyId) {
      const company = companies.getCompany(dbUser.companyId);
      if (company) {
        companyPlan = {
          tier: company.tier,
          maxUsers: company.maxUsers,
          status: company.status,
          subscriptionStatus: company.subscriptionStatus || null,
        };
      }
    }

    res.json({
      ok: true,
      subscription: {
        status: dbUser.subscriptionStatus,
        stripeCustomerId: dbUser.stripeCustomerId || null,
        stripeSubscriptionId: dbUser.stripeSubscriptionId || null,
        companyPlan,
        entitlements: dbUser.entitlements || { tools: [] }
      },
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   CREATE CHECKOUT
========================================================= */

router.post("/checkout", authRequired, async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const type = clean(req.body?.type, 50);

    if (!validatePlan(type)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid subscription type",
      });
    }

    const dbUser = users.findById(user.id);
    if (!dbUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const successUrl =
      clean(req.body?.successUrl) || process.env.STRIPE_SUCCESS_URL;

    const cancelUrl =
      clean(req.body?.cancelUrl) || process.env.STRIPE_CANCEL_URL;

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({
        ok: false,
        error: "Missing success or cancel URL",
      });
    }

    const checkoutUrl = await createCheckoutSession({
      userId: user.id,
      type,
      successUrl,
      cancelUrl,
    });

    audit({
      actorId: user.id,
      action: "SUBSCRIPTION_CHECKOUT_STARTED",
      targetType: "Plan",
      targetId: type,
    });

    res.json({ ok: true, checkoutUrl });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADMIN ACTIVATE PLAN
========================================================= */

router.post(
  "/admin/activate",
  authRequired,
  requireRole(users.ROLES.ADMIN),
  (req, res) => {
    try {
      const userId = clean(req.body?.userId);
      const planType = clean(req.body?.planType);

      if (!validatePlan(planType)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid plan type",
        });
      }

      const dbUser = users.findById(userId);
      if (!dbUser) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      dbUser.subscriptionStatus = users.SUBSCRIPTION.ACTIVE;
      saveUser(dbUser);

      grantPlanTools(userId, planType);

      audit({
        actorId: req.user.id,
        action: "PLAN_ACTIVATED",
        targetType: "User",
        targetId: userId,
        metadata: { planType },
      });

      res.json({ ok: true });

    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

/* =========================================================
   CANCEL SUBSCRIPTION
========================================================= */

router.post("/cancel", authRequired, async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const dbUser = users.findById(user.id);
    if (!dbUser?.stripeSubscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "No active subscription",
      });
    }

    await cancelSubscription(user.id);

    dbUser.subscriptionStatus = users.SUBSCRIPTION.LOCKED;
    saveUser(dbUser);

    revokePlanTools(user.id);

    // 🔥 CRITICAL: revoke sessions immediately
    sessionAdapter.revokeAllUserSessions(user.id);

    audit({
      actorId: user.id,
      action: "SUBSCRIPTION_CANCELLED",
      targetType: "User",
      targetId: user.id,
    });

    res.json({
      ok: true,
      message: "Subscription cancelled and entitlements revoked",
    });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
