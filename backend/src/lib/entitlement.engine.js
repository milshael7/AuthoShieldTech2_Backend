// backend/src/lib/entitlement.engine.js
// Enterprise Entitlement Engine
// Handles tool-based billing access (not role-based overrides)

const { readDb, updateDb } = require("./db");

/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function toTimestamp(date) {
  if (!date) return null;
  return new Date(date).getTime();
}

function ensureUserEntitlements(user) {
  if (!user.entitlements) {
    user.entitlements = {
      tools: [],
      expiresAt: null
    };
  }

  if (!Array.isArray(user.entitlements.tools)) {
    user.entitlements.tools = [];
  }
}

/* =========================================================
   CORE CHECK
========================================================= */

function userHasTool(user, toolId) {
  if (!user) return false;

  ensureUserEntitlements(user);

  // If expired → deny
  if (user.entitlements.expiresAt) {
    const expiry = toTimestamp(user.entitlements.expiresAt);
    if (expiry && expiry < now()) {
      return false;
    }
  }

  return user.entitlements.tools.includes(toolId);
}

/* =========================================================
   GRANT TOOL
========================================================= */

function grantTool(userId, toolId, expiresAt = null) {
  updateDb((db) => {
    const user = (db.users || []).find(u => u.id === userId);
    if (!user) return db;

    ensureUserEntitlements(user);

    if (!user.entitlements.tools.includes(toolId)) {
      user.entitlements.tools.push(toolId);
    }

    if (expiresAt) {
      user.entitlements.expiresAt = expiresAt;
    }

    user.updatedAt = new Date().toISOString();
    return db;
  });
}

/* =========================================================
   REVOKE TOOL
========================================================= */

function revokeTool(userId, toolId) {
  updateDb((db) => {
    const user = (db.users || []).find(u => u.id === userId);
    if (!user || !user.entitlements) return db;

    user.entitlements.tools =
      user.entitlements.tools.filter(t => t !== toolId);

    user.updatedAt = new Date().toISOString();
    return db;
  });
}

/* =========================================================
   REVOKE ALL
========================================================= */

function revokeAllTools(userId) {
  updateDb((db) => {
    const user = (db.users || []).find(u => u.id === userId);
    if (!user) return db;

    user.entitlements = {
      tools: [],
      expiresAt: null
    };

    user.updatedAt = new Date().toISOString();
    return db;
  });
}

/* =========================================================
   CLEANUP EXPIRED ENTITLEMENTS
========================================================= */

function expireExpiredEntitlements() {
  updateDb((db) => {
    const users = db.users || [];

    users.forEach(user => {
      if (!user.entitlements) return;

      const expiry = toTimestamp(user.entitlements.expiresAt);
      if (expiry && expiry < now()) {
        user.entitlements = {
          tools: [],
          expiresAt: null
        };
        user.updatedAt = new Date().toISOString();
      }
    });

    return db;
  });
}

module.exports = {
  userHasTool,
  grantTool,
  revokeTool,
  revokeAllTools,
  expireExpiredEntitlements
};
