// backend/src/routes/billing.routes.js
// Billing & Subscription Control — Stripe Integrated • Persistent • Tenant Safe

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
   HELPERS
========================================================= */

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Invalid auth context" });
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

/* =========================================================
   GET CURRENT SUBSCRIPTION
========================================================= */

router.get("/me", authRequired, (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const dbUser = users.findById(user.id);
    if (!dbUser) {
      return res.status(404).json({ error: "User not found" });
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

    return res.json({
      ok: true,
      subscription: {
        status: dbUser.subscriptionStatus,
        role: dbUser.role,
        stripeCustomerId: dbUser.stripeCustomerId || null,
        stripeSubscriptionId: dbUser.stripeSubscriptionId || null,
        companyPlan,
      },
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   CREATE STRIPE CHECKOUT SESSION
========================================================= */

router.post("/checkout", authRequired, async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    const type = clean(req.body?.type, 50);
    if (!type) {
      return res.status(400).json({ error: "Missing plan type" });
    }

    const successUrl =
      clean(req.body?.successUrl) || process.env.STRIPE_SUCCESS_URL;

    const cancelUrl =
      clean(req.body?.cancelUrl) || process.env.STRIPE_CANCEL_URL;

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({
        error: "Missing success or cancel URL",
      });
    }

    const checkoutUrl = await createCheckoutSession({
      userId: user.id,
      type,
      successUrl,
      cancelUrl,
    });

    return res.json({
      ok: true,
      checkoutUrl,
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   OPEN STRIPE CUSTOMER PORTAL
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
        error: "Missing return URL",
      });
    }

    const portalUrl = await createCustomerPortalSession({
      userId: user.id,
      returnUrl,
    });

    return res.json({
      ok: true,
      portalUrl,
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   CANCEL SUBSCRIPTION
========================================================= */

router.post("/cancel", authRequired, async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;

    await cancelSubscription(user.id);

    return res.json({
      ok: true,
      message: "Subscription cancelled",
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   ADMIN SET SUBSCRIPTION STATUS (MANUAL OVERRIDE)
========================================================= */

router.post(
  "/admin/set-status",
  authRequired,
  requireRole(users.ROLES.ADMIN),
  (req, res) => {
    try {
      const userId = clean(req.body?.userId, 100);
      const status = clean(req.body?.status, 50);

      if (!userId || !status) {
        return res.status(400).json({
          error: "Missing userId or status",
        });
      }

      const dbUser = users.findById(userId);
      if (!dbUser) {
        return res.status(404).json({
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

      return res.json({
        ok: true,
        userId,
        status,
      });

    } catch (e) {
      return res.status(400).json({
        error: e?.message || String(e),
      });
    }
  }
);

module.exports = router;
