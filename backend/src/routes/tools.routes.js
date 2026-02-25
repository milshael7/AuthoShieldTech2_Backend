// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Catalog + Access Control (Admin/Manager/Company/Individual)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");

/* =========================================================
   HELPERS
========================================================= */

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

function nowIso() {
  return new Date().toISOString();
}

function isAdmin(user) {
  return user?.role === users.ROLES.ADMIN;
}

function isManager(user) {
  return user?.role === users.ROLES.MANAGER;
}

function isCompany(user) {
  return (
    user?.role === users.ROLES.COMPANY ||
    user?.role === users.ROLES.SMALL_COMPANY
  );
}

function isIndividual(user) {
  return user?.role === users.ROLES.INDIVIDUAL;
}

function isSubActive(user) {
  return String(user?.subscriptionStatus || "") === users.SUBSCRIPTION.ACTIVE;
}

/**
 * Tool schema (stored in db.tools):
 * {
 *   id: "vuln-scan",
 *   name: "Vulnerability Scanner",
 *   description: "...",
 *   tier: "free" | "paid" | "enterprise",
 *   category: "security" | "business" | "ops",
 *   enterpriseOnly: boolean,
 *   companyAllowed: boolean,    // if Company role can use it
 *   managerAllowed: boolean,    // if Manager role can use it
 *   adminAllowed: boolean,      // if Admin role can use it
 *   enabled: boolean
 * }
 */

function canAccessTool(user, tool) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  // Admin: everything
  if (isAdmin(user)) return tool.adminAllowed !== false;

  // Manager: everything except enterpriseOnly unless explicitly allowed
  if (isManager(user)) {
    if (tool.enterpriseOnly) return tool.managerAllowed === true;
    return tool.managerAllowed !== false;
  }

  // Company: only if explicitly allowed AND (generally business/security tools)
  if (isCompany(user)) {
    return tool.companyAllowed === true;
  }

  // Individual: free always; paid only if subscription active
  if (isIndividual(user)) {
    if (tool.tier === "free") return true;
    if (tool.tier === "paid" && isSubActive(user)) return true;
    return false;
  }

  return false;
}

function ensureToolsSeed(db) {
  db.tools = normalizeArray(db.tools);

  if (db.tools.length > 0) return;

  db.tools = [
    {
      id: "vuln-scan",
      name: "Vulnerability Scanner",
      description: "Run baseline vulnerability discovery against assets.",
      tier: "free",
      category: "security",
      enabled: true,
      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: true,
    },
    {
      id: "threat-feed",
      name: "Threat Intelligence Feed",
      description: "Live threat feed and signal correlation.",
      tier: "paid",
      category: "security",
      enabled: true,
      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: true,
    },
    {
      id: "autodev-65",
      name: "AutoDev 6.5 (AutoProtect)",
      description: "Automated protection engine (governed).",
      tier: "paid",
      category: "ops",
      enabled: true,
      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: false, // per your rules: company doesn't get autoprotec
    },
    {
      id: "enterprise-monitor",
      name: "Enterprise Attack Monitor",
      description: "Global radar monitoring & response controls.",
      tier: "enterprise",
      category: "business",
      enabled: true,
      enterpriseOnly: true,
      adminAllowed: true,
      managerAllowed: true, // allow manager for enterprise ops
      companyAllowed: false,
    },
  ];
}

/* =========================================================
   ROUTES
========================================================= */

router.use(authRequired);

/**
 * GET /api/tools/catalog
 * Returns tools list with accessible flag (frontend uses this to show/hide/lock tools)
 */
router.get("/catalog", (req, res) => {
  try {
    const db = readDb();
    ensureToolsSeed(db);
    writeDb(db);

    const user = (db.users || []).find((u) => String(u.id) === String(req.user.id)) || req.user;
    const toolsArr = normalizeArray(db.tools);

    const tools = toolsArr.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || "",
      tier: t.tier || "free",
      category: t.category || "security",
      enabled: t.enabled !== false,
      accessible: canAccessTool(user, t),
    }));

    return res.json({ ok: true, tools, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/tools/access/:toolId
 * Enforces access for any tool launch
 */
router.get("/access/:toolId", (req, res) => {
  try {
    const db = readDb();
    ensureToolsSeed(db);
    writeDb(db);

    const { toolId } = req.params;
    const toolsArr = normalizeArray(db.tools);

    const tool = toolsArr.find((t) => String(t.id) === String(toolId));
    if (!tool) {
      return res.status(404).json({ ok: false, error: "Tool not found" });
    }

    const user = (db.users || []).find((u) => String(u.id) === String(req.user.id)) || req.user;

    const allowed = canAccessTool(user, tool);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: "Access denied" });
    }

    return res.json({
      ok: true,
      tool: {
        id: tool.id,
        name: tool.name,
        tier: tool.tier,
        category: tool.category,
      },
      time: nowIso(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
