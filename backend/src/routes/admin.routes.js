// backend/src/routes/admin.routes.js
// Admin API — Phase 15 Enterprise Forecast Intelligence
// Metrics • Revenue • Forecast • Cashflow • Risk Adjusted

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");
const { nanoid } = require("nanoid");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   AUDIT
========================================================= */

function audit(action, actorId, targetType, targetId, meta = {}) {
  const db = readDb();
  db.audit.push({
    id: nanoid(),
    at: new Date().toISOString(),
    action,
    actorId,
    targetType,
    targetId,
    meta,
  });
}

/* =========================================================
   EXECUTIVE METRICS
========================================================= */

router.get("/metrics", (req, res) => {
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

    const conversionRate =
      trialUsers.length + activeUsers.length > 0
        ? Number((activeUsers.length /
            (trialUsers.length + activeUsers.length)).toFixed(4))
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
        conversionRate,
        estimatedLTV,
      },
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REVENUE FORECAST ENGINE
========================================================= */

router.get("/forecast", (req, res) => {
  try {
    const db = readDb();
    const revenue = db.revenueSummary || {};
    const usersList = db.users || [];

    const activeSubscribers = usersList.filter(
      u => u.subscriptionStatus === "Active"
    ).length;

    const churnRate = usersList.length > 0
      ? usersList.filter(u => u.subscriptionStatus === "Locked").length /
        usersList.length
      : 0;

    const avgSubscription =
      revenue.subscriptionRevenue && activeSubscribers > 0
        ? revenue.subscriptionRevenue / activeSubscribers
        : 0;

    const projectedMRR = avgSubscription * activeSubscribers;

    const churnAdjustedMRR =
      projectedMRR * (1 - churnRate);

    const forecast30 = churnAdjustedMRR;
    const forecast90 = churnAdjustedMRR * 3;

    res.json({
      ok: true,
      forecast: {
        projectedMRR: Number(projectedMRR.toFixed(2)),
        churnAdjustedMRR: Number(churnAdjustedMRR.toFixed(2)),
        forecastNext30Days: Number(forecast30.toFixed(2)),
        forecastNext90Days: Number(forecast90.toFixed(2)),
        churnRate: Number(churnRate.toFixed(4)),
      },
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   CASHFLOW PROJECTION
========================================================= */

router.get("/cashflow", (req, res) => {
  try {
    const db = readDb();
    const revenue = db.revenueSummary || {};

    const totalRevenue = revenue.totalRevenue || 0;
    const refunded = revenue.refundedAmount || 0;
    const disputed = revenue.disputedAmount || 0;

    const netRevenue = totalRevenue - refunded - disputed;

    const riskFactor =
      totalRevenue > 0
        ? (refunded + disputed) / totalRevenue
        : 0;

    const confidenceScore =
      Number((1 - riskFactor).toFixed(4));

    res.json({
      ok: true,
      cashflow: {
        totalRevenue,
        refunded,
        disputed,
        netRevenue: Number(netRevenue.toFixed(2)),
        confidenceScore,
      },
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REVENUE SUMMARY
========================================================= */

router.get("/revenue/summary", (req, res) => {
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
   USERS / NOTIFICATIONS
========================================================= */

router.get("/users", (req, res) => {
  try {
    res.json({ ok: true, users: users.listUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/notifications", (req, res) => {
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
