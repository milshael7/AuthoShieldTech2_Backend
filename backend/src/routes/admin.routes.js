// backend/src/routes/admin.routes.js
// Admin API — Phase 11 Enterprise Hardened
// Approval + Company Hierarchy + Tool Governance + Scan Control
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
   SCAN CONTROL ENGINE
========================================================= */

/**
 * FORCE COMPLETE
 */
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

/**
 * CANCEL SCAN
 */
router.post("/scan/:id/cancel", (req, res) => {
  try {
    const scanId = requireId(req.params.id);

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      if (scan.status === "completed") {
        throw new Error("Cannot cancel completed scan");
      }

      scan.status = "cancelled";
      scan.completedAt = new Date().toISOString();
    });

    audit(
      "ADMIN_CANCEL_SCAN",
      req.user.id,
      "Scan",
      scanId
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * OVERRIDE RISK
 */
router.post("/scan/:id/override-risk", (req, res) => {
  try {
    const scanId = requireId(req.params.id);
    const riskScore = Number(req.body?.riskScore);

    if (!Number.isFinite(riskScore)) {
      throw new Error("Invalid risk score");
    }

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      if (scan.status !== "completed") {
        throw new Error("Only completed scans can be overridden");
      }

      if (!scan.result) {
        scan.result = { overview: {}, findings: [] };
      }

      scan.result.overview.riskScore = riskScore;

      if (riskScore >= 70) {
        scan.result.overview.riskLevel = "High";
      } else if (riskScore >= 45) {
        scan.result.overview.riskLevel = "Moderate";
      } else {
        scan.result.overview.riskLevel = "Low";
      }
    });

    audit(
      "ADMIN_OVERRIDE_RISK",
      req.user.id,
      "Scan",
      scanId,
      { riskScore }
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   TOOL GOVERNANCE
========================================================= */

router.get("/companies/:id/tools", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const result = securityTools.listTools(companyId);

    res.json({ ok: true, ...result });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/companies/:id/tools/:toolId/block", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const result = securityTools.blockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit(
      "ADMIN_BLOCK_TOOL",
      req.user.id,
      "Company",
      companyId,
      { toolId }
    );

    res.json({ ok: true, ...result });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/companies/:id/tools/:toolId/unblock", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const result = securityTools.unblockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit(
      "ADMIN_UNBLOCK_TOOL",
      req.user.id,
      "Company",
      companyId,
      { toolId }
    );

    res.json({ ok: true, ...result });

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
