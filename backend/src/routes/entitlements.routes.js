// backend/src/routes/entitlements.routes.js
// Enterprise Entitlement Management
// Admin-controlled billing bridge layer

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");

const {
  grantTool,
  revokeTool,
  revokeAllTools,
  userHasTool
} = require("../lib/entitlement.engine");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function isAdmin(user) {
  return user.role === users.ROLES.ADMIN;
}

function isManager(user) {
  return user.role === users.ROLES.MANAGER;
}

function findUser(userId) {
  const db = readDb();
  return (db.users || []).find(u => u.id === userId);
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
   ADMIN GRANT TOOL
========================================================= */

router.post("/grant", (req, res) => {
  const actor = req.user;

  if (!isAdmin(actor)) {
    return res.status(403).json({
      ok: false,
      error: "Admin only"
    });
  }

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

  grantTool(userId, toolId, expiresAt || null);

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
   ADMIN REVOKE TOOL
========================================================= */

router.post("/revoke", (req, res) => {
  const actor = req.user;

  if (!isAdmin(actor)) {
    return res.status(403).json({
      ok: false,
      error: "Admin only"
    });
  }

  const { userId, toolId } = req.body || {};

  if (!userId || !toolId) {
    return res.status(400).json({
      ok: false,
      error: "userId and toolId required"
    });
  }

  revokeTool(userId, toolId);

  return res.json({
    ok: true,
    message: "Tool revoked",
    toolId,
    userId,
    time: nowISO()
  });
});

/* =========================================================
   ADMIN REVOKE ALL TOOLS
========================================================= */

router.post("/revoke-all", (req, res) => {
  const actor = req.user;

  if (!isAdmin(actor)) {
    return res.status(403).json({
      ok: false,
      error: "Admin only"
    });
  }

  const { userId } = req.body || {};

  if (!userId) {
    return res.status(400).json({
      ok: false,
      error: "userId required"
    });
  }

  revokeAllTools(userId);

  return res.json({
    ok: true,
    message: "All tools revoked",
    userId,
    time: nowISO()
  });
});

module.exports = router;
