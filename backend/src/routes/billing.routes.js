// backend/src/routes/billing.routes.js
// Billing & Subscription Control — Persistent • Enforced • Tenant Safe

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 100) {
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
   COMPANY UPGRADE (PERSISTENT)
========================================================= */

router.post(
  "/company/upgrade",
  authRequired,
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const user = requireUser(req, res);
      if (!user) return;

      const newTier = clean(req.body?.tier, 50);
      if (!newTier) {
        return res.status(400).json({ error: "Missing tier" });
      }

      const updated = companies.upgradeCompany(
        user.companyId,
        newTier,
        user.id
      );

      audit({
        actorId: user.id,
        action: "COMPANY_PLAN_UPGRADED",
        targetType: "Company",
        targetId: updated.id,
        metadata: { newTier },
      });

      return res.json({
        ok: true,
        tier: updated.tier,
        maxUsers: updated.maxUsers,
      });

    } catch (e) {
      return res.status(400).json({
        error: e?.message || String(e),
      });
    }
  }
);

/* =========================================================
   INDIVIDUAL PLAN ACTIVATION
========================================================= */

router.post(
  "/autodev/activate",
  authRequired,
  requireRole(users.ROLES.INDIVIDUAL),
  (req, res) => {
    try {
      const user = requireUser(req, res);
      if (!user) return;

      const dbUser = users.findById(user.id);
      if (!dbUser) {
        return res.status(404).json({ error: "User not found" });
      }

      dbUser.subscriptionStatus = users.SUBSCRIPTION.ACTIVE;
      saveUser(dbUser);

      audit({
        actorId: user.id,
        action: "INDIVIDUAL_SUBSCRIPTION_ACTIVATED",
        targetType: "User",
        targetId: user.id,
      });

      return res.json({
        ok: true,
        subscriptionStatus: dbUser.subscriptionStatus,
      });

    } catch (e) {
      return res.status(400).json({
        error: e?.message || String(e),
      });
    }
  }
);

/* =========================================================
   ADMIN SET SUBSCRIPTION STATUS
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
