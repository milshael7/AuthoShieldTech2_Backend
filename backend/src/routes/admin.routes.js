// backend/src/routes/admin.routes.js
// Phase 33 — Admin Platform Control + Protection Scope

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
  if (req.user.role !== ADMIN_ROLE && req.user.role !== FINANCE_ROLE) {
    return res.status(403).json({ ok: false, error: "Finance or Admin only" });
  }
  next();
}

/* =========================================================
   INTERNAL HELPER — ENSURE ADMIN STATE
========================================================= */

function ensureAdminState(db) {
  if (!db.adminState) {
    db.adminState = {
      defenseMode: "auto", // auto | manual
      protectedTenants: []
    };
  }
  if (!Array.isArray(db.adminState.protectedTenants)) {
    db.adminState.protectedTenants = [];
  }
}

/* =========================================================
   METRICS (UNCHANGED)
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

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
   EXECUTIVE RISK
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
   PLATFORM TENANT LIST
========================================================= */

router.get("/tenants", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const companies = db.companies || [];

    res.json({
      ok: true,
      tenants: companies.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status || "Active"
      }))
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADMIN PROTECTION SCOPE
========================================================= */

router.get("/protection-scope", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    ensureAdminState(db);

    res.json({
      ok: true,
      defenseMode: db.adminState.defenseMode,
      protectedTenants: db.adminState.protectedTenants
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   TOGGLE DEFENSE MODE
========================================================= */

router.post("/defense-mode", requireAdmin, (req, res) => {
  try {
    const { mode } = req.body;
    if (!["auto", "manual"].includes(mode)) {
      return res.status(400).json({ ok: false, error: "Invalid mode" });
    }

    const db = readDb();
    ensureAdminState(db);

    db.adminState.defenseMode = mode;
    writeDb(db);

    res.json({
      ok: true,
      defenseMode: mode
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADD TENANT TO PROTECTION
========================================================= */

router.post("/protect/:tenantId", requireAdmin, (req, res) => {
  try {
    const { tenantId } = req.params;

    const db = readDb();
    ensureAdminState(db);

    if (!db.adminState.protectedTenants.includes(tenantId)) {
      db.adminState.protectedTenants.push(tenantId);
    }

    writeDb(db);

    res.json({
      ok: true,
      protectedTenants: db.adminState.protectedTenants
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REMOVE TENANT FROM PROTECTION
========================================================= */

router.delete("/protect/:tenantId", requireAdmin, (req, res) => {
  try {
    const { tenantId } = req.params;

    const db = readDb();
    ensureAdminState(db);

    db.adminState.protectedTenants =
      db.adminState.protectedTenants.filter(id => id !== tenantId);

    writeDb(db);

    res.json({
      ok: true,
      protectedTenants: db.adminState.protectedTenants
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   PLATFORM INTEGRITY SNAPSHOT
========================================================= */

router.get("/platform-health", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    const usersList = db.users || [];
    const events = db.securityEvents || [];

    const activeUsers = usersList.filter(u => u.subscriptionStatus === "Active").length;
    const criticalEvents = events.filter(e => e.severity === "critical").length;

    res.json({
      ok: true,
      health: {
        systemStatus: "Operational",
        activeUsers,
        criticalEvents,
        totalEvents: events.length
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
