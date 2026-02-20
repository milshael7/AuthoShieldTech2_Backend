// backend/src/routes/admin.routes.js
// Admin API — Phase 12 Enterprise Hardened
// Approval + Company Hierarchy + Tool Governance + Scan Control
// Revenue Intelligence Layer Added
// Revenue Safe • Audit Logged • Status Guarded

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb, updateDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { listNotifications } = require("../lib/notify");
const { nanoid } = require("nanoid");

/* =========================================================
   ROLE SAFETY
========================================================= */

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function requireId(id) {
  const val = clean(id, 100);
  if (!val) throw new Error("Invalid id");
  return val;
}

function ensureArrays(db) {
  if (!Array.isArray(db.scans)) db.scans = [];
  if (!Array.isArray(db.companies)) db.companies = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.audit)) db.audit = [];
}

function audit(action, actorId, targetType, targetId, meta = {}) {
  const db = readDb();
  ensureArrays(db);

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
   🔥 REVENUE INTELLIGENCE
========================================================= */

router.get("/revenue", (req, res) => {
  try {
    const db = readDb();
    const apUsers = Object.values(db.autoprotek?.users || {});

    const totalSubscribers = apUsers.length;

    const activeSubscribers = apUsers.filter(
      (u) => u.status === "ACTIVE" && u.subscriptionStatus === "ACTIVE"
    );

    const pastDueSubscribers = apUsers.filter(
      (u) => u.subscriptionStatus === "PAST_DUE"
    );

    const automationRevenue = activeSubscribers.reduce(
      (sum, u) => sum + (u.pricing?.automationService || 500),
      0
    );

    const platformRevenue = activeSubscribers.reduce(
      (sum, u) => sum + (u.pricing?.platformFee || 50),
      0
    );

    const projectedMonthlyRevenue = automationRevenue + platformRevenue;

    res.json({
      ok: true,
      totalSubscribers,
      activeSubscribers: activeSubscribers.length,
      pastDueSubscribers: pastDueSubscribers.length,
      projectedMonthlyRevenue,
      breakdown: {
        automationServiceRevenue: automationRevenue,
        platformFeeRevenue: platformRevenue,
      },
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   SCAN CONTROL ENGINE
========================================================= */

router.post("/scan/:id/force-complete", (req, res) => {
  try {
    const scanId = requireId(req.params.id);

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      if (scan.status === "completed") {
        throw new Error("Scan already completed");
      }

      if (scan.status === "awaiting_payment") {
        throw new Error("Cannot complete unpaid scan");
      }

      scan.status = "completed";
      scan.completedAt = new Date().toISOString();

      if (!scan.result) {
        scan.result = {
          overview: {
            riskScore: 50,
            riskLevel: "Moderate",
          },
          findings: ["Manually completed by admin."],
        };
      }
    });

    audit(
      "ADMIN_FORCE_COMPLETE_SCAN",
      req.user.id,
      "Scan",
      scanId
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
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
