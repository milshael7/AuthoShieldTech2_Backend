// backend/src/routes/admin.routes.js
// Admin API — Supreme Authority (Phase 8 Hardened)
// Approval System + Tool Governance + Safety Enforcement

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
   APPROVAL SYSTEM — HARDENED
========================================================= */

/**
 * List pending users (admin sees both pending + manager_approved)
 */
router.get("/pending-users", (req, res) => {
  try {
    const db = readDb();

    const list = (db.users || []).filter(
      (u) =>
        u.status === users.APPROVAL_STATUS.PENDING ||
        u.status === users.APPROVAL_STATUS.MANAGER_APPROVED
    );

    return res.json({
      ok: true,
      users: list,
    });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/**
 * Admin final approval
 */
router.post("/users/:id/approve", (req, res) => {
  try {
    const id = requireId(req.params.id);
    const db = readDb();

    const u = (db.users || []).find((x) => x.id === id);
    if (!u) throw new Error("User not found");

    if (u.role === ADMIN_ROLE) {
      throw new Error("Cannot modify admin approval state");
    }

    if (
      u.status !== users.APPROVAL_STATUS.PENDING &&
      u.status !== users.APPROVAL_STATUS.MANAGER_APPROVED
    ) {
      throw new Error("User not eligible for approval");
    }

    u.status = users.APPROVAL_STATUS.APPROVED;
    u.approvedBy = "admin";

    writeDb(db);

    audit("ADMIN_APPROVE_USER", req.user.id, id);

    return res.json({
      ok: true,
      user: u,
    });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/**
 * Admin deny
 */
router.post("/users/:id/deny", (req, res) => {
  try {
    const id = requireId(req.params.id);
    const db = readDb();

    const u = (db.users || []).find((x) => x.id === id);
    if (!u) throw new Error("User not found");

    if (u.role === ADMIN_ROLE) {
      throw new Error("Cannot deny admin account");
    }

    if (u.status === users.APPROVAL_STATUS.DENIED) {
      throw new Error("User already denied");
    }

    u.status = users.APPROVAL_STATUS.DENIED;
    u.locked = true;

    writeDb(db);

    audit("ADMIN_DENY_USER", req.user.id, id);

    return res.json({
      ok: true,
      user: u,
    });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/* =========================================================
   TOOL GOVERNANCE
========================================================= */

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
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/companies/:id/tools/:toolId/block", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const updated = securityTools.blockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit("ADMIN_BLOCK_TOOL", req.user.id, companyId, { toolId });

    recordEvent({
      type: "tool_blocked",
      severity: "warn",
      source: "admin",
      target: toolId,
      description: `Admin blocked tool ${toolId}`,
      meta: { companyId },
    });

    return res.json({
      ok: true,
      blocked: updated.blocked,
    });

  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/companies/:id/tools/:toolId/unblock", (req, res) => {
  try {
    const companyId = requireId(req.params.id);
    const toolId = requireId(req.params.toolId);

    const updated = securityTools.unblockTool(
      companyId,
      toolId,
      req.user.id
    );

    audit("ADMIN_UNBLOCK_TOOL", req.user.id, companyId, { toolId });

    recordEvent({
      type: "tool_unblocked",
      severity: "info",
      source: "admin",
      target: toolId,
      description: `Admin unblocked tool ${toolId}`,
      meta: { companyId },
    });

    return res.json({
      ok: true,
      blocked: updated.blocked,
    });

  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   EXISTING ADMIN SYSTEM
========================================================= */

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
