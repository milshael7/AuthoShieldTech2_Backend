// backend/src/lib/audit.js
// Enterprise Immutable Audit Ledger
// Tamper-Evident • Hash Chained • Safe • Backward Compatible

const crypto = require("crypto");
const { updateDb, readDb } = require("./db");

/* =========================================================
   HASH UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeRecordHash(record) {
  const base = JSON.stringify({
    ts: record.ts,
    actor: record.actor,
    role: record.role,
    action: record.action,
    target: record.target,
    companyId: record.companyId,
    detail: record.detail,
    prevHash: record.prevHash,
  });

  return sha256(base);
}

/* =========================================================
   WRITE AUDIT (IMMUTABLE CHAIN)
========================================================= */

function writeAudit(input = {}) {
  try {
    const db = readDb();
    if (!Array.isArray(db.audit)) db.audit = [];

    const prev = db.audit[db.audit.length - 1];
    const prevHash = prev ? prev.hash : "GENESIS";

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

      prevHash,
      hash: null, // calculated below
    };

    record.hash = computeRecordHash(record);

    updateDb((db2) => {
      if (!Array.isArray(db2.audit)) db2.audit = [];
      db2.audit.push(record);

      // Hard cap: keep last 10,000 events
      if (db2.audit.length > 10_000) {
        db2.audit = db2.audit.slice(-10_000);
      }

      return db2;
    });

    return record;
  } catch (err) {
    console.error("⚠️ Audit write failed:", err);
    return null;
  }
}

/* =========================================================
   VERIFY AUDIT INTEGRITY
========================================================= */

function verifyAuditIntegrity() {
  try {
    const db = readDb();
    const logs = db.audit || [];

    if (logs.length === 0) {
      return { ok: true, message: "No audit records" };
    }

    for (let i = 0; i < logs.length; i++) {
      const current = logs[i];

      const expectedHash = computeRecordHash(current);

      if (current.hash !== expectedHash) {
        return {
          ok: false,
          tamperedAt: current.id,
          index: i,
        };
      }

      if (i > 0) {
        if (current.prevHash !== logs[i - 1].hash) {
          return {
            ok: false,
            brokenChainAt: current.id,
            index: i,
          };
        }
      }
    }

    return {
      ok: true,
      totalRecords: logs.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* =========================================================
   BACKWARD COMPATIBILITY
========================================================= */

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
  audit,
  verifyAuditIntegrity,
};
