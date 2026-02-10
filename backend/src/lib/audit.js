// backend/src/lib/audit.js
// Central Audit Writer — HARDENED & SAFE
//
// PURPOSE:
// - Single source of truth for audit events
// - Safe concurrent writes
// - Consistent schema across admin / manager / system
//
// RULES:
// - No auth logic
// - Never throws
// - Always returns a record or null

const crypto = require("crypto");
const { updateDb } = require("./db");

/**
 * writeAudit({
 *   actor,        // user id or "system"
 *   role,         // admin | manager | system | user
 *   action,       // STRING ENUM (ex: USER_CREATED)
 *   target,       // optional id (userId, companyId, tradeId)
 *   companyId,    // optional tenant scope
 *   detail        // optional object
 * })
 */
function writeAudit(input = {}) {
  try {
    const record = {
      id: crypto.randomUUID(),
      ts: Date.now(),

      actor: String(input.actor || "system"),
      role: String(input.role || "system"),
      action: String(input.action || "UNKNOWN"),

      target: input.target ? String(input.target) : null,
      companyId: input.companyId ? String(input.companyId) : null,

      detail:
        input.detail && typeof input.detail === "object"
          ? input.detail
          : {},
    };

    updateDb((db) => {
      if (!Array.isArray(db.audit)) db.audit = [];
      db.audit.push(record);

      // Hard cap: keep last 10,000 events
      if (db.audit.length > 10_000) {
        db.audit = db.audit.slice(-10_000);
      }

      return db;
    });

    return record;
  } catch (err) {
    console.error("⚠️ Audit write failed:", err);
    return null;
  }
}

module.exports = {
  writeAudit,
};
