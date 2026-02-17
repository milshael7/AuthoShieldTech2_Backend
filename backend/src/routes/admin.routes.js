// backend/src/routes/admin.routes.js
// Admin API — Supreme Authority Version (Phase 6 — Tool Governance Added)

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");

const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { listNotifications } = require("../lib/notify");
const { recordEvent } = require("../services/securityEvents");

/* =========================================================
   ROLE SAFETY
========================================================= */

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function requireId(id) {
  const clean = cleanStr(id, 100);
  if (!clean) throw new Error("Invalid id");
  return clean;
}

function audit(action, actorId, targetId, meta = {}) {
  const db = readDb();
  db.audit = db.audit || [];

  db.audit.push({
    id: Date.now().toString(),
    at: new Date().toISOString(),
    action,
    actorId,
    targetId,
    meta,
  });

  writeDb(db);
}

/* =========================================================
   TOOL GOVERNANCE
========================================================= */

/**
 * View installed tools for a company
 */
router.get("/companies/:id/tools", (req, res) => {
  try {
    const companyId = requireId(req.params.id);

    const result = securityTools.listTools(companyId);

    return res.json({
      ok: true,
      companyId,
      installed: result.installed,
      blocked: result.blocked || [],
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/**
 * Globally block tool for a company
 */
router.post("/companies/:id/tools/:toolId/block", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const updated = securityTools.blockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit("ADMIN_BLOCK_TOOL", req.user.id, companyId, {
      toolId,
    });

    recordEvent({
      type: "tool_blocked",
      severity: "warn",
      source: "admin",
      target: toolId,
      description: `Admin blocked tool ${toolId} for company ${companyId}`,
      meta: { companyId },
    });

    return res.json({
      ok: true,
      blocked: updated.blocked,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/**
 * Unblock tool
 */
router.post("/companies/:id/tools/:toolId/unblock", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const updated = securityTools.unblockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit("ADMIN_UNBLOCK_TOOL", req.user.id, companyId, {
      toolId,
    });

    recordEvent({
      type: "tool_unblocked",
      severity: "info",
      source: "admin",
      target: toolId,
      description: `Admin unblocked tool ${toolId} for company ${companyId}`,
      meta: { companyId },
    });

    return res.json({
      ok: true,
      blocked: updated.blocked,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   EXISTING ADMIN SYSTEM (unchanged below)
========================================================= */

// USERS
router.get("/users", (req, res) => {
  try {
    return res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// COMPANIES
router.get("/companies", (req, res) => {
  try {
    return res.json({
      ok: true,
      companies: companies.listCompanies(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// NOTIFICATIONS
router.get("/notifications", (req, res) => {
  try {
    return res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
