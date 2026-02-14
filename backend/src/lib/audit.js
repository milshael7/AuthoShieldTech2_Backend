// backend/src/lib/audit.js
// Central Audit Writer — HARDENED & BACKWARD COMPATIBLE

const crypto = require("crypto");
const { updateDb } = require("./db");

/**
 * Internal writer
 */
function writeAudit(input = {}) {
  try {
    const record = {
      id: crypto.randomUUID(),
      ts: Date.now(),

      actorId: input.actorId || input.actor || "system",
      role: input.role || null,
      action: String(input.action || "UNKNOWN"),

      targetType: input.targetType || null,
      targetId: input.targetId || input.target || null,
      companyId: input.companyId || null,

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
 * 🔥 Backward compatibility alias
 * Old routes use: audit(...)
 */
const audit = writeAudit;

module.exports = {
  writeAudit,
  audit,
};
