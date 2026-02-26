// backend/src/lib/entitlement.engine.js
// Enterprise Entitlement Engine — Hardened v2
// Per-tool expiration model
// Safe against cross-tool expiration wipe

const { readDb, updateDb } = require("./db");

/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function toTimestamp(date) {
  if (!date) return null;
  const t = new Date(date).getTime();
  return Number.isFinite(t) ? t : null;
}

function ensureUserEntitlements(user) {
  if (!user.entitlements) {
    user.entitlements = {
      tools: []
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

  const nowTs = now();

  const entry = user.entitlements.tools.find(
    (t) => String(t.toolId) === String(toolId)
  );

  if (!entry) return false;

  if (entry.expiresAt) {
    const expiry = toTimestamp(entry.expiresAt);
    if (expiry && expiry < nowTs) {
      return false;
    }
  }

  return true;
}

/* =========================================================
   GRANT TOOL
   - expiresAt optional
========================================================= */

function grantTool(userId, toolId, expiresAt = null) {
  updateDb((db) => {
    const user = (db.users || []).find((u) => u.id === userId);
    if (!user) return db;

    ensureUserEntitlements(user);

    const existing = user.entitlements.tools.find(
      (t) => String(t.toolId) === String(toolId)
    );

    if (existing) {
      // update expiration if provided
      if (expiresAt) {
        existing.expiresAt = expiresAt;
      }
    } else {
      user.entitlements.tools.push({
        toolId: String(toolId),
        expiresAt: expiresAt || null,
      });
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
    const user = (db.users || []).find((u) => u.id === userId);
    if (!user || !user.entitlements) return db;

    user.entitlements.tools = user.entitlements.tools.filter(
      (t) => String(t.toolId) !== String(toolId)
    );

    user.updatedAt = new Date().toISOString();
    return db;
  });
}

/* =========================================================
   REVOKE ALL
========================================================= */

function revokeAllTools(userId) {
  updateDb((db) => {
    const user = (db.users || []).find((u) => u.id === userId);
    if (!user) return db;

    user.entitlements = { tools: [] };
    user.updatedAt = new Date().toISOString();
    return db;
  });
}

/* =========================================================
   CLEANUP EXPIRED ENTITLEMENTS
   - Removes ONLY expired tools
========================================================= */

function expireExpiredEntitlements() {
  updateDb((db) => {
    const users = db.users || [];
    const nowTs = now();

    users.forEach((user) => {
      if (!user.entitlements || !Array.isArray(user.entitlements.tools)) return;

      user.entitlements.tools = user.entitlements.tools.filter((t) => {
        if (!t.expiresAt) return true;

        const expiry = toTimestamp(t.expiresAt);
        if (!expiry) return true;

        return expiry >= nowTs;
      });

      user.updatedAt = new Date().toISOString();
    });

    return db;
  });
}

module.exports = {
  userHasTool,
  grantTool,
  revokeTool,
  revokeAllTools,
  expireExpiredEntitlements,
};
