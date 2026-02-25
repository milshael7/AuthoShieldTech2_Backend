// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Catalog + Entitlement-Enforced Access

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");

const {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray
} = require("../lib/tools.engine");

/* =========================================================
   HELPERS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function findUser(db, userId) {
  return (db.users || []).find(u => String(u.id) === String(userId));
}

/* =========================================================
   ROUTES
========================================================= */

router.use(authRequired);

/**
 * GET /api/tools/catalog
 * Returns full tool catalog with access flag
 */
router.get("/catalog", (req, res) => {
  try {
    const db = readDb();

    seedToolsIfEmpty(db);
    writeDb(db);

    const user = findUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    const toolsArr = normalizeArray(db.tools);

    const tools = toolsArr.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description || "",
      tier: tool.tier || "free",
      category: tool.category || "security",
      enabled: tool.enabled !== false,
      accessible: canAccessTool(
        user,
        tool,
        users.ROLES
      )
    }));

    return res.json({
      ok: true,
      tools,
      time: nowIso()
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

/**
 * GET /api/tools/access/:toolId
 * Strict enforcement before launching any tool
 */
router.get("/access/:toolId", (req, res) => {
  try {
    const db = readDb();

    seedToolsIfEmpty(db);
    writeDb(db);

    const { toolId } = req.params;
    const toolsArr = normalizeArray(db.tools);

    const tool = toolsArr.find(t => String(t.id) === String(toolId));
    if (!tool) {
      return res.status(404).json({
        ok: false,
        error: "Tool not found"
      });
    }

    const user = findUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    const allowed = canAccessTool(
      user,
      tool,
      users.ROLES
    );

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: "Access denied"
      });
    }

    return res.json({
      ok: true,
      tool: {
        id: tool.id,
        name: tool.name,
        tier: tool.tier,
        category: tool.category
      },
      time: nowIso()
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

module.exports = router;
