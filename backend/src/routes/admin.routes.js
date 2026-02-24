// backend/src/routes/admin.routes.js
// Phase 32 Executive Intelligence – Fully Stable

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireFinanceOrAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE && req.user.role !== FINANCE_ROLE) {
    return res.status(403).json({ ok: false, error: "Finance or Admin only" });
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
    const invoices = db.invoices || [];

    const activeSubscribers = usersList.filter(u => u.subscriptionStatus === "Active").length;
    const trialUsers = usersList.filter(u => u.subscriptionStatus === "Trial").length;
    const lockedUsers = usersList.filter(u => u.subscriptionStatus === "Locked").length;

    const totalRevenue = Number(db.revenueSummary?.totalRevenue || 0);

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   EXECUTIVE RISK INDEX
========================================================= */

router.get("/executive-risk", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const incidents = db.securityEvents || [];

    const critical = incidents.filter(e => e.severity === "critical").length;
    const high = incidents.filter(e => e.severity === "high").length;

    const score = Math.min(100, critical * 20 + high * 10);

    res.json({
      ok: true,
      executiveRisk: {
        score,
        level:
          score > 75 ? "Critical" :
          score > 40 ? "Elevated" :
          "Stable"
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   PREDICTIVE CHURN
========================================================= */

router.get("/predictive-churn", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const locked = usersList.filter(u => u.subscriptionStatus === "Locked").length;
    const total = usersList.length || 1;

    const churnProbability = Number((locked / total).toFixed(4));

    res.json({
      ok: true,
      predictiveChurn: {
        probability: churnProbability,
        riskLevel:
          churnProbability > 0.3 ? "High" :
          churnProbability > 0.15 ? "Moderate" :
          "Low"
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   COMPLIANCE REPORT
========================================================= */

router.get("/compliance/report", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const events = db.securityEvents || [];

    const critical = events.filter(e => e.severity === "critical").length;
    const high = events.filter(e => e.severity === "high").length;

    res.json({
      ok: true,
      complianceReport: {
        totalEvents: events.length,
        criticalFindings: critical,
        highFindings: high,
        status:
          critical > 0 ? "Non-Compliant" :
          high > 5 ? "Needs Review" :
          "Compliant"
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   COMPLIANCE HISTORY (SAFE EMPTY)
========================================================= */

router.get("/compliance/history", requireFinanceOrAdmin, (req, res) => {
  res.json({
    ok: true,
    history: []
  });
});

module.exports = router;
