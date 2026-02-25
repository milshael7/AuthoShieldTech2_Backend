// backend/src/routes/admin.routes.js
// Phase 34 — Admin Platform Control + Autodev Tier Governance

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
      defenseMode: "auto",
      protectedTenants: []
    };
  }
  if (!Array.isArray(db.adminState.protectedTenants)) {
    db.adminState.protectedTenants = [];
  }
}

/* =========================================================
   METRICS
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
   TENANTS
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
   AUTODEV — USER TIER GOVERNANCE
========================================================= */

/**
 * List users with tier info
 */
router.get("/users/tier", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    res.json({
      ok: true,
      users: usersList.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        freedomEnabled: !!u.freedomEnabled,
        autoprotectEnabled: !!u.autoprotectEnabled,
        managedCompanies: u.managedCompanies?.length || 0
      }))
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Grant Freedom (Seat / Individual Upgrade)
 */
router.post("/users/:userId/grant-freedom", requireAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    const db = readDb();

    const u = db.users.find(x => x.id === userId);
    if (!u) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    u.freedomEnabled = true;
    u.updatedAt = new Date().toISOString();

    writeDb(db);

    res.json({
      ok: true,
      message: "Freedom granted",
      userId
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Revoke Freedom
 */
router.post("/users/:userId/revoke-freedom", requireAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    const db = readDb();

    const u = db.users.find(x => x.id === userId);
    if (!u) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    u.freedomEnabled = false;
    u.autoprotectEnabled = false;
    u.managedCompanies = [];
    u.updatedAt = new Date().toISOString();

    writeDb(db);

    res.json({
      ok: true,
      message: "Freedom revoked",
      userId
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
