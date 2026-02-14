// backend/src/lib/audit.js
// Central Audit Writer — BACKWARD COMPATIBLE
// Supports BOTH: audit() and writeAudit()
// Never throws • Safe concurrent writes

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

      actor: String(input.actor || input.actorId || "system"),
      role: String(input.role || "system"),
      action: String(input.action || "UNKNOWN"),

      target: input.target || input.targetId
        ? String(input.target || input.targetId)
        : null,

      targetType: input.targetType
        ? String(input.targetType)
        : null,

      companyId: input.companyId
        ? String(input.companyId)
        : null,

      metadata:
        input.metadata && typeof input.metadata === "object"
          ? input.metadata
          : {},

      detail:
        input.detail && typeof input.detail === "object"
          ? input.detail
          : {},
    };

    updateDb((db) => {
      if (!Array.isArray(db.audit)) db.audit = [];
      db.audit.push(record);

      // Hard cap
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
 * 🔁 BACKWARD COMPATIBILITY LAYER
 * Old code calls audit({...})
 */
function audit(input = {}) {
  return writeAudit(input);
}

module.exports = {
  writeAudit,
  audit, // ← keeps old routes working
};
