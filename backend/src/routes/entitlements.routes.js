// backend/src/routes/entitlements.routes.js
// Enterprise Entitlement Management — Hardened v2
// Admin + Manager Scoped • Company Bound • Audit Safe

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

const {
  grantTool,
  revokeTool,
  revokeAllTools
} = require("../lib/entitlement.engine");

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").toLowerCase();
}

function isAdmin(user) {
  return normalize(user.role) === normalize(users.ROLES.ADMIN);
}

function isManager(user) {
  return normalize(user.role) === normalize(users.ROLES.MANAGER);
}

function findUser(userId) {
  const db = readDb();
  return (db.users || []).find(u => u.id === userId);
}

function sameCompany(actor, target) {
  return actor.companyId && actor.companyId === target.companyId;
}

function nowISO() {
  return new Date().toISOString();
}

/* =========================================================
   VIEW MY ENTITLEMENTS
========================================================= */

router.get("/me", (req, res) => {
  const user = findUser(req.user.id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found"
    });
  }

  return res.json({
    ok: true,
    entitlements: user.entitlements || { tools: [] },
    time: nowISO()
  });
});

/* =========================================================
   GRANT TOOL (ADMIN OR MANAGER SCOPED)
========================================================= */

router.post("/grant", (req, res) => {
  const actor = req.user;
  const { userId, toolId, expiresAt } = req.body || {};

  if (!userId || !toolId) {
    return res.status(400).json({
      ok: false,
      error: "userId and toolId required"
    });
  }

  const target = findUser(userId);
  if (!target) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found"
    });
  }

  // Admin can grant globally
  if (!isAdmin(actor)) {
    // Managers can only grant within same company
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden"
      });
    }
  }

  grantTool(userId, toolId, expiresAt || null);

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "ENTITLEMENT_GRANTED",
    detail: { targetUser: userId, toolId }
  });

  return res.json({
    ok: true,
    message: "Tool granted",
    toolId,
    userId,
    expiresAt: expiresAt || null,
    time: nowISO()
  });
});

/* =========================================================
   REVOKE TOOL
========================================================= */

router.post("/revoke", (req, res) => {
  const actor = req.user;
  const { userId, toolId } = req.body || {};

  if (!userId || !toolId) {
    return res.status(400).json({
      ok: false,
      error: "userId and toolId required"
    });
  }

  const target = findUser(userId);
  if (!target) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found"
    });
  }

  if (!isAdmin(actor)) {
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden"
      });
    }
  }

  revokeTool(userId, toolId);

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "ENTITLEMENT_REVOKED",
    detail: { targetUser: userId, toolId }
  });

  return res.json({
    ok: true,
    message: "Tool revoked",
    toolId,
    userId,
    time: nowISO()
  });
});

/* =========================================================
   REVOKE ALL TOOLS
========================================================= */

router.post("/revoke-all", (req, res) => {
  const actor = req.user;
  const { userId } = req.body || {};

  if (!userId) {
    return res.status(400).json({
      ok: false,
      error: "userId required"
    });
  }

  const target = findUser(userId);
  if (!target) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found"
    });
  }

  if (!isAdmin(actor)) {
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden"
      });
    }
  }

  revokeAllTools(userId);

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "ALL_ENTITLEMENTS_REVOKED",
    detail: { targetUser: userId }
  });

  return res.json({
    ok: true,
    message: "All tools revoked",
    userId,
    time: nowISO()
  });
});

module.exports = router;
