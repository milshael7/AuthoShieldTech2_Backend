// backend/src/lib/audit.js
// Central Audit Writer — ENTERPRISE SAFE + BACKWARD COMPATIBLE
//
// Guarantees:
// - Never throws
// - Safe schema
// - Backward compatible with older routes using `audit()`
// - Hard capped storage

const crypto = require("crypto");
const { updateDb } = require("./db");

/**
 * Core writer
 */
function writeAudit(input = {}) {
  try {
    const record = {
      id: crypto.randomUUID(),
      ts: Date.now(),

      actorId: String(input.actorId || input.actor || "system"),
      role: String(input.role || "system"),
      action: String(input.action || "UNKNOWN"),

      targetType: input.targetType
        ? String(input.targetType)
        : null,

      targetId: input.targetId
        ? String(input.targetId)
        : input.target
        ? String(input.target)
        : null,

      companyId: input.companyId
        ? String(input.companyId)
        : null,

      metadata:
        input.metadata && typeof input.metadata === "object"
          ? input.metadata
          : input.detail && typeof input.detail === "object"
          ? input.detail
          : {},
    };

    updateDb((db) => {
      if (!Array.isArray(db.audit)) db.audit = [];
      db.audit.push(record);

      // Hard cap to prevent uncontrolled growth
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
 * Backward-compatible alias
 * Many routes import: const { audit } = require(...)
 */
function audit(input = {}) {
  return writeAudit(input);
}

module.exports = {
  writeAudit,
  audit,
};
