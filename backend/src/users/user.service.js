// backend/src/routes/admin.routes.js
// Phase 31 — Executive Intelligence + Growth Analytics (Hardened)
// ✅ Case-safe role guards
// ✅ Adds /audit/integrity endpoint (uses verifyAuditIntegrity)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");
const {
  generateComplianceReport,
  getComplianceHistory,
} = require("../services/compliance.service");

const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

/* =========================================================
   ROLE FALLBACKS (CRASH-PROOF + CASE SAFE)
========================================================= */

const ROLES = users?.ROLES || {};
const ADMIN_ROLE = ROLES.ADMIN || "Admin";
const FINANCE_ROLE = ROLES.FINANCE || "Finance";

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function hasRole(reqUser, roleName) {
  return normRole(reqUser?.role) === normRole(roleName);
}

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireAdmin(req, res, next) {
  if (!hasRole(req.user, ADMIN_ROLE)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

function requireFinanceOrAdmin(req, res, next) {
  if (!hasRole(req.user, ADMIN_ROLE) && !hasRole(req.user, FINANCE_ROLE)) {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only",
    });
  }
  next();
}

/* =========================================================
   EXECUTIVE METRICS
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();

    const usersList = db.users || [];

    const activeSubscribers = usersList.filter(
      (u) => u.subscriptionStatus === "Active"
    ).length;

    const trialUsers = usersList.filter(
      (u) => u.subscriptionStatus === "Trial"
    ).length;

    const lockedUsers = usersList.filter(
      (u) => u.subscriptionStatus === "Locked"
    ).length;

    const totalRevenue = db.revenueSummary?.totalRevenue || 0;

    return res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   SUBSCRIBER GROWTH ANALYTICS
========================================================= */

router.get("/subscriber-growth", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const dailyMap = {};

    usersList.forEach((u) => {
      if (!u.createdAt) return;
      const day = String(u.createdAt).slice(0, 10);

      if (!dailyMap[day]) {
        dailyMap[day] = { newUsers: 0, newActive: 0 };
      }

      dailyMap[day].newUsers++;

      if (u.subscriptionStatus === "Active") {
        dailyMap[day].newActive++;
      }
    });

    const sortedDays = Object.keys(dailyMap).sort();

    let cumulativeUsers = 0;
    let cumulativeActive = 0;

    const result = sortedDays.map((day) => {
      cumulativeUsers += dailyMap[day].newUsers;
      cumulativeActive += dailyMap[day].newActive;

      return {
        date: day,
        totalUsers: cumulativeUsers,
        activeSubscribers: cumulativeActive,
      };
    });

    return res.json({ ok: true, growth: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   COMPLIANCE
========================================================= */

router.get("/compliance/report", requireFinanceOrAdmin, async (req, res) => {
  try {
    const report = await generateComplianceReport();
    return res.json({ ok: true, complianceReport: report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/compliance/history", requireFinanceOrAdmin, (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const history = getComplianceHistory(limit);
    return res.json({ ok: true, history });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   AUDIT INTEGRITY
========================================================= */

router.get("/audit/integrity", requireFinanceOrAdmin, (req, res) => {
  try {
    const result = verifyAuditIntegrity();
    return res.json({ ok: true, integrity: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   USERS
========================================================= */

router.get("/users", requireAdmin, (req, res) => {
  try {
    return res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", requireAdmin, (req, res) => {
  try {
    return res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
