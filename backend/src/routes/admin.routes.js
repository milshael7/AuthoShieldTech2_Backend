// backend/src/routes/admin.routes.js
// Admin API — Phase 9
// Approval + Tool Governance + Hierarchical Company System

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { listNotifications } = require("../lib/notify");
const { readDb, writeDb } = require("../lib/db");
const { nanoid } = require("nanoid");

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

function ensureArrays(db) {
  if (!Array.isArray(db.companies)) db.companies = [];
}

/* =========================================================
   APPROVAL SYSTEM
========================================================= */

router.get("/pending-users", (req, res) => {
  try {
    return res.json({
      ok: true,
      users: users.listPendingUsers(),
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post("/users/:id/approve", (req, res) => {
  try {
    const id = requireId(req.params.id);

    const updated = users.adminApproveUser(
      id,
      req.user.id,
      req.user.role
    );

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post("/users/:id/deny", (req, res) => {
  try {
    const id = requireId(req.params.id);

    const updated = users.adminDenyUser(
      id,
      req.user.id,
      req.user.role
    );

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.get("/approvals", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;

    return res.json({
      ok: true,
      approvals: users.listApprovalHistory(limit),
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/* =========================================================
   COMPANY SYSTEM (NEW HIERARCHY)
========================================================= */

/**
 * Create Company
 * Can optionally create as child of another company
 */
router.post("/companies", (req, res) => {
  try {
    const db = readDb();
    ensureArrays(db);

    const name = cleanStr(req.body?.name, 150);
    const parentCompanyId = cleanStr(req.body?.parentCompanyId, 100) || null;

    if (!name) {
      return res.status(400).json({
        error: "Company name required",
      });
    }

    if (parentCompanyId) {
      const parent = db.companies.find(c => c.id === parentCompanyId);
      if (!parent) {
        return res.status(400).json({
          error: "Parent company not found",
        });
      }
    }

    const newCompany = {
      id: nanoid(),
      name,
      parentCompanyId,
      createdAt: new Date().toISOString(),
      suspended: false,
      sizeTier: "standard",
    };

    db.companies.push(newCompany);
    writeDb(db);

    return res.status(201).json({
      ok: true,
      company: newCompany,
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

/**
 * Company Hierarchy Tree
 */
router.get("/companies-tree", (req, res) => {
  try {
    const db = readDb();
    ensureArrays(db);

    const buildTree = (parentId = null) => {
      return db.companies
        .filter(c => c.parentCompanyId === parentId)
        .map(c => ({
          ...c,
          children: buildTree(c.id),
        }));
    };

    return res.json({
      ok: true,
      tree: buildTree(null),
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
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
