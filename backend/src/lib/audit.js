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
 *   actor,
 *   role,
 *   action,
 *   target,
 *   companyId,
 *   detail
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

/**
 * 🔁 Backward compatibility layer
 * Many routes still call `audit({...})`
 */
function audit(input = {}) {
  return writeAudit({
    actor: input.actorId || input.actor || "system",
    role: input.role || "system",
    action: input.action,
    target: input.targetId || input.target,
    companyId: input.companyId,
    detail: input.metadata || input.detail,
  });
}

module.exports = {
  writeAudit,
  audit, // ← critical fix
};
