// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Hardened Access Enforcement v2
// Subscription Locked • Entitlement Enforced • Audited • Abuse Aware

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");

const {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray
} = require("../lib/tools.engine");

/* ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function findUser(db, userId) {
  return (db.users || []).find(u => String(u.id) === String(userId));
}

function subscriptionActive(user) {
  const s = String(user.subscriptionStatus || "").toLowerCase();
  return s === "active" || s === "trial";
}

function recordToolViolation(user, toolId, reason) {
  audit({
    actor: user.id,
    role: user.role,
    action: "TOOL_ACCESS_DENIED",
    target: toolId,
    metadata: { reason }
  });

  updateDb((db) => {
    const u = db.users.find(x => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.toolViolations =
      (u.securityFlags.toolViolations || 0) + 1;

    if (u.securityFlags.toolViolations >= 5) {
      u.locked = true;
      audit({
        actor: u.id,
        role: u.role,
        action: "ACCOUNT_AUTO_LOCKED_TOOL_ABUSE"
      });
    }

    return db;
  });
}

/* ========================================================= */

router.use(authRequired);

/* =========================================================
   GET CATALOG
========================================================= */

router.get("/catalog", (req, res) => {
  try {
    const db = readDb();

    seedToolsIfEmpty(db);

    const user = findUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const toolsArr = normalizeArray(db.tools);

    const tools = toolsArr.map((tool) => {

      const accessible =
        tool.enabled !== false &&
        subscriptionActive(user) &&
        canAccessTool(user, tool, users.ROLES);

      return {
        id: tool.id,
        name: tool.name,
        description: tool.description || "",
        tier: tool.tier || "free",
        category: tool.category || "security",
        enabled: tool.enabled !== false,
        accessible
      };
    });

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

/* =========================================================
   STRICT TOOL ACCESS
========================================================= */

router.get("/access/:toolId", (req, res) => {
  try {
    const db = readDb();

    seedToolsIfEmpty(db);

    const { toolId } = req.params;
    const toolsArr = normalizeArray(db.tools);

    const tool = toolsArr.find(
      t => String(t.id) === String(toolId)
    );

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

    /* ===============================
       ENFORCEMENT LAYER
    ================================ */

    if (tool.enabled === false) {
      recordToolViolation(user, toolId, "TOOL_DISABLED");
      return res.status(403).json({
        ok: false,
        error: "Tool disabled"
      });
    }

    if (!subscriptionActive(user)) {
      recordToolViolation(user, toolId, "INACTIVE_SUBSCRIPTION");
      return res.status(403).json({
        ok: false,
        error: "Subscription inactive"
      });
    }

    const allowed = canAccessTool(
      user,
      tool,
      users.ROLES
    );

    if (!allowed) {
      recordToolViolation(user, toolId, "ENTITLEMENT_DENIED");
      return res.status(403).json({
        ok: false,
        error: "Access denied"
      });
    }

    /* ===============================
       SUCCESS — AUDIT GRANT
    ================================ */

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_ACCESS_GRANTED",
      target: toolId
    });

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
