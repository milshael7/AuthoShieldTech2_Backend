// backend/src/routes/admin.routes.js
// Admin API — Phase 17 Governance Layer
// Admin + Finance Role Separation
// Revenue • Forecast • Cashflow • Predictive Churn Engine

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
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
    return res.status(403).json({ ok: false, error: "Finance or Admin only" });
  }
  next();
}

/* =========================================================
   🔥 EXECUTIVE METRICS (Finance + Admin)
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const invoices = db.invoices || [];

    const activeUsers = usersList.filter(u => u.subscriptionStatus === "Active");
    const trialUsers = usersList.filter(u => u.subscriptionStatus === "Trial");
    const lockedUsers = usersList.filter(u => u.subscriptionStatus === "Locked");

    const totalRevenue = db.revenueSummary?.totalRevenue || 0;

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    const mrr = invoices
      .filter(i =>
        i.type === "subscription" &&
        now - new Date(i.createdAt).getTime() <= THIRTY_DAYS
      )
      .reduce((sum, i) => sum + i.amount, 0);

    const arr = mrr * 12;

    const payingUsers = new Set(
      invoices.filter(i => i.type === "subscription").map(i => i.userId)
    ).size;

    const arpu = payingUsers > 0
      ? Number((totalRevenue / payingUsers).toFixed(2))
      : 0;

    const churnRate = usersList.length > 0
      ? Number((lockedUsers.length / usersList.length).toFixed(4))
      : 0;

    const estimatedLTV =
      churnRate > 0 ? Number((arpu / churnRate).toFixed(2)) : 0;

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers: activeUsers.length,
        trialUsers: trialUsers.length,
        lockedUsers: lockedUsers.length,
        totalRevenue,
        MRR: Number(mrr.toFixed(2)),
        ARR: Number(arr.toFixed(2)),
        ARPU: arpu,
        churnRate,
        estimatedLTV,
      },
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 PREDICTIVE CHURN RISK (Finance + Admin)
========================================================= */

router.get("/churn-risk", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const invoices = db.invoices || [];

    const now = Date.now();
    const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

    const results = [];

    for (const user of usersList) {
      let riskScore = 0;

      if (user.subscriptionStatus === "Locked") riskScore += 50;
      if (user.subscriptionStatus === "Trial") riskScore += 10;

      const recentPayment = invoices.find(i =>
        i.userId === user.id &&
        now - new Date(i.createdAt).getTime() <= SIXTY_DAYS
      );

      if (!recentPayment) riskScore += 20;

      let level = "LOW";
      if (riskScore >= 60) level = "HIGH";
      else if (riskScore >= 30) level = "MEDIUM";

      results.push({
        userId: user.id,
        email: user.email,
        riskScore,
        level,
      });
    }

    res.json({
      ok: true,
      churnRisk: results,
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 REVENUE SUMMARY (Finance + Admin)
========================================================= */

router.get("/revenue/summary", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    res.json({
      ok: true,
      revenue: db.revenueSummary || {},
      invoices: db.invoices?.length || 0,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔐 USER LIST (Admin Only)
========================================================= */

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, users: users.listUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔐 NOTIFICATIONS (Admin Only)
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
