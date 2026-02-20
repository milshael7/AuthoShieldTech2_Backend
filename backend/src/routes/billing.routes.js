// backend/src/routes/billing.routes.js
// Billing & Subscription Control — Enterprise Hardened
// Stripe Safe • Plan Scoped • Revenue Protected

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");

const {
  createCheckoutSession,
  createCustomerPortalSession,
  cancelSubscription,
} = require("../services/stripe.service");

/* =========================================================
   PLAN CONTROL
========================================================= */

const INDIVIDUAL_PLANS = ["individual_autodev"];
const COMPANY_PLANS = ["micro", "small", "mid", "enterprise"];

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
  const idx = db.users.findIndex((u) => u.id === updatedUser.id);
  if (idx !== -1) {
    db.users[idx] = updatedUser;
    writeDb(db);
  }
}

function validatePlanForUser(dbUser, type) {
  if (INDIVIDUAL_PLANS.includes(type)) {
    return true;
  }

  if (COMPANY_PLANS.includes(type) && dbUser.companyId) {
    return true;
  }

  throw new Error("Plan not allowed for this user type");
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

    const dbUser = users.findById(user.id);
    if (!dbUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    validatePlanForUser(dbUser, type);

    if (dbUser.subscriptionStatus === users.SUBSCRIPTION.ACTIVE) {
      return res.status(400).json({
        ok: false,
        error: "Already subscribed",
      });
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
   STRIPE CUSTOMER PORTAL
========================================================= */

router.post("/portal", authRequired, async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const returnUrl =
      clean(req.body?.returnUrl) ||
      process.env.STRIPE_PORTAL_RETURN_URL;

    if (!returnUrl) {
      return res.status(400).json({
        ok: false,
        error: "Missing return URL",
      });
    }

    const portalUrl = await createCustomerPortalSession({
      userId: user.id,
      returnUrl,
    });

    res.json({ ok: true, portalUrl });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

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

    const subId = dbUser.stripeSubscriptionId;

    await cancelSubscription(user.id);

    audit({
      actorId: user.id,
      action: "SUBSCRIPTION_CANCEL_REQUESTED",
      targetType: "StripeSubscription",
      targetId: subId,
    });

    res.json({
      ok: true,
      message: "Subscription cancelled",
    });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADMIN MANUAL STATUS OVERRIDE
========================================================= */

router.post(
  "/admin/set-status",
  authRequired,
  requireRole(users.ROLES.ADMIN),
  (req, res) => {
    try {
      const userId = clean(req.body?.userId, 100);
      const status = clean(req.body?.status, 50);

      if (!Object.values(users.SUBSCRIPTION).includes(status)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid subscription status",
        });
      }

      const dbUser = users.findById(userId);
      if (!dbUser) {
        return res.status(404).json({
          ok: false,
          error: "User not found",
        });
      }

      dbUser.subscriptionStatus = status;
      saveUser(dbUser);

      audit({
        actorId: req.user.id,
        action: "SUBSCRIPTION_STATUS_CHANGED",
        targetType: "User",
        targetId: userId,
        metadata: { status },
      });

      res.json({ ok: true, userId, status });

    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

module.exports = router;
