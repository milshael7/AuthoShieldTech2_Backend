// backend/src/routes/admin.routes.js
// Phase 30 — Unified Executive Intelligence Layer
// SOC2 • Revenue • Metrics • Risk • Compliance History

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");
const {
  generateComplianceReport,
  getComplianceHistory
} = require("../services/compliance.service");

const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

function requireFinanceOrAdmin(req, res, next) {
  if (
    req.user.role !== ADMIN_ROLE &&
    req.user.role !== FINANCE_ROLE
  ) {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only",
    });
  }
  next();
}

/* =========================================================
   📊 EXECUTIVE METRICS (RESTORED)
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();

    const usersList = db.users || [];
    const invoices = db.invoices || [];

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

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    const mrr = invoices
      .filter(
        (i) =>
          i.type === "subscription" &&
          now - new Date(i.createdAt).getTime() <= THIRTY_DAYS
      )
      .reduce((sum, i) => sum + i.amount, 0);

    const arr = mrr * 12;

    const payingUsers = new Set(
      invoices
        .filter((i) => i.type === "subscription")
        .map((i) => i.userId)
    ).size;

    const arpu =
      payingUsers > 0
        ? Number((totalRevenue / payingUsers).toFixed(2))
        : 0;

    const churnRate =
      usersList.length > 0
        ? Number((lockedUsers / usersList.length).toFixed(4))
        : 0;

    const estimatedLTV =
      churnRate > 0
        ? Number((arpu / churnRate).toFixed(2))
        : 0;

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue,
        MRR: Number(mrr.toFixed(2)),
        ARR: Number(arr.toFixed(2)),
        ARPU: arpu,
        churnRate,
        estimatedLTV,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔎 SOC2 COMPLIANCE REPORT
========================================================= */

router.get(
  "/compliance/report",
  requireFinanceOrAdmin,
  async (req, res) => {
    try {
      const report = await generateComplianceReport();
      res.json({ ok: true, complianceReport: report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* =========================================================
   📚 COMPLIANCE HISTORY
========================================================= */

router.get(
  "/compliance/history",
  requireFinanceOrAdmin,
  (req, res) => {
    try {
      const limit = Number(req.query.limit || 20);
      const history = getComplianceHistory(limit);

      res.json({
        ok: true,
        history,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* =========================================================
   🔐 USERS
========================================================= */

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔐 NOTIFICATIONS
========================================================= */

router.get("/notifications", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
