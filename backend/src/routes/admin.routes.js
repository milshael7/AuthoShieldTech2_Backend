// Phase 35 — Admin Platform Control + Executive Intelligence Layer

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");

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
   METRICS
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const activeSubscribers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const trialUsers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "trial"
    ).length;

    const lockedUsers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "locked"
    ).length;

    const totalRevenue = Number(
      db.revenueSummary?.totalRevenue || 0
    );

    const MRR = Number(db.revenueSummary?.MRR || 0);
    const churnRate = Number(db.revenueSummary?.churnRate || 0);

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue,
        MRR,
        churnRate,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   EXECUTIVE RISK
========================================================= */

router.get(
  "/executive-risk",
  requireFinanceOrAdmin,
  (req, res) => {
    try {
      const db = readDb();
      const incidents = db.securityEvents || [];

      const critical = incidents.filter(
        (e) => e.severity === "critical"
      ).length;

      const high = incidents.filter(
        (e) => e.severity === "high"
      ).length;

      const score = Math.min(100, critical * 20 + high * 10);

      res.json({
        ok: true,
        executiveRisk: {
          score,
          level:
            score > 75
              ? "Critical"
              : score > 40
              ? "Elevated"
              : "Stable",
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* =========================================================
   AUDIT PREVIEW (NEW)
========================================================= */

router.get("/audit-preview", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const audit = db.audit || db.auditEvents || [];

    const sorted = [...audit]
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() -
          new Date(a.timestamp).getTime()
      )
      .slice(0, 20);

    res.json({
      ok: true,
      events: sorted,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   AUTODEV GLOBAL STATS (NEW)
========================================================= */

router.get("/autodev-stats", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const totalSubscribers = usersList.filter(
      (u) => u.autoprotectEnabled === true
    ).length;

    const activeSubscribers = usersList.filter(
      (u) =>
        u.autoprotectEnabled === true &&
        String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const pastDueSubscribers = usersList.filter(
      (u) =>
        u.autoprotectEnabled === true &&
        String(u.subscriptionStatus).toLowerCase() === "pastdue"
    ).length;

    const totalAttachedCompanies = usersList.reduce(
      (sum, u) =>
        sum + (Array.isArray(u.managedCompanies)
          ? u.managedCompanies.length
          : 0),
      0
    );

    const automationLoadScore =
      totalAttachedCompanies > 0
        ? Math.min(
            100,
            Math.round(
              (totalAttachedCompanies /
                (totalSubscribers || 1)) *
                10
            )
          )
        : 0;

    res.json({
      ok: true,
      totalSubscribers,
      activeSubscribers,
      pastDueSubscribers,
      totalAttachedCompanies,
      automationLoadScore,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   TENANTS
========================================================= */

router.get("/tenants", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const companies = db.companies || [];

    res.json({
      ok: true,
      tenants: companies.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status || "Active",
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   PLATFORM HEALTH
========================================================= */

router.get("/platform-health", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    const usersList = db.users || [];
    const events = db.securityEvents || [];

    const activeUsers = usersList.filter(
      (u) =>
        String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const criticalEvents = events.filter(
      (e) => e.severity === "critical"
    ).length;

    res.json({
      ok: true,
      health: {
        systemStatus: "Operational",
        activeUsers,
        criticalEvents,
        totalEvents: events.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
