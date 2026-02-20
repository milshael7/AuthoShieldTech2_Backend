// backend/src/routes/admin.routes.js
// Admin API — Phase 14 Enterprise Intelligence
// Revenue • MRR • ARR • Churn • Conversion • Invoice Intelligence

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb, updateDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
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
  writeDb(db);
}

/* =========================================================
   🔥 EXECUTIVE METRICS
========================================================= */

router.get("/metrics", (req, res) => {
  try {
    const db = readDb();

    const allUsers = db.users || [];
    const invoices = db.invoices || [];

    const activeUsers = allUsers.filter(
      (u) => u.subscriptionStatus === "Active"
    );

    const trialUsers = allUsers.filter(
      (u) => u.subscriptionStatus === "Trial"
    );

    const lockedUsers = allUsers.filter(
      (u) => u.subscriptionStatus === "Locked"
    );

    const totalRevenue = db.revenueSummary?.totalRevenue || 0;

    // MRR calculation (sum of last 30 days subscription invoices)
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
      allUsers.length > 0
        ? Number(
            (
              lockedUsers.length /
              allUsers.length
            ).toFixed(4)
          )
        : 0;

    const conversionRate =
      trialUsers.length + activeUsers.length > 0
        ? Number(
            (
              activeUsers.length /
              (trialUsers.length + activeUsers.length)
            ).toFixed(4)
          )
        : 0;

    const estimatedLTV =
      churnRate > 0 ? Number((arpu / churnRate).toFixed(2)) : 0;

    res.json({
      ok: true,
      metrics: {
        totalUsers: allUsers.length,
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
   MONTHLY BREAKDOWN
========================================================= */

router.get("/revenue/monthly", (req, res) => {
  try {
    const db = readDb();
    const invoices = db.invoices || [];
    const monthly = {};

    for (const inv of invoices) {
      const date = new Date(inv.createdAt);
      const key = `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;

      if (!monthly[key]) {
        monthly[key] = 0;
      }

      monthly[key] += inv.amount;
    }

    res.json({ ok: true, monthly });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   USERS / COMPANIES / NOTIFICATIONS
========================================================= */

router.get("/users", (req, res) => {
  try {
    res.json({ ok: true, users: users.listUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/companies", (req, res) => {
  try {
    res.json({ ok: true, companies: companies.listCompanies() });
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
