// backend/src/lib/audit.js
// Enterprise Immutable Audit Ledger — Phase 23
// Cryptographic Hash Chain • Sequence Locked • Tamper Evident • SOC2 Ready

const crypto = require("crypto");
const { updateDb, readDb } = require("./db");

/* =========================================================
   CONSTANTS
========================================================= */

const GENESIS_HASH = "GENESIS";

/* =========================================================
   HASH UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeRecordHash(record) {
  const base = JSON.stringify({
    seq: record.seq,
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
   WRITE AUDIT (IMMUTABLE + SEQUENCE LOCKED)
========================================================= */

function writeAudit(input = {}) {
  try {
    const db = readDb();

    if (!Array.isArray(db.audit)) db.audit = [];
    if (!db.auditMeta) {
      db.auditMeta = {
        lastHash: null,
        lastSequence: 0,
        integrityVersion: 1,
      };
    }

    const prevHash =
      db.auditMeta.lastHash || GENESIS_HASH;

    const seq = db.auditMeta.lastSequence + 1;

    const record = {
      id: crypto.randomUUID(),
      seq,
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
      hash: null,
    };

    record.hash = computeRecordHash(record);

    updateDb((db2) => {
      if (!Array.isArray(db2.audit)) db2.audit = [];
      if (!db2.auditMeta) {
        db2.auditMeta = {
          lastHash: null,
          lastSequence: 0,
          integrityVersion: 1,
        };
      }

      db2.audit.push(record);

      db2.auditMeta.lastHash = record.hash;
      db2.auditMeta.lastSequence = seq;

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
    const meta = db.auditMeta || {};

    if (logs.length === 0) {
      return {
        ok: true,
        message: "No audit records",
      };
    }

    let expectedPrevHash = GENESIS_HASH;
    let expectedSeq = 1;

    for (let i = 0; i < logs.length; i++) {
      const current = logs[i];

      /* Sequence validation */
      if (current.seq !== expectedSeq) {
        return {
          ok: false,
          error: "Sequence mismatch",
          index: i,
          expectedSeq,
          foundSeq: current.seq,
        };
      }

      /* Chain validation */
      if (current.prevHash !== expectedPrevHash) {
        return {
          ok: false,
          error: "Broken hash chain",
          index: i,
        };
      }

      /* Hash recalculation */
      const expectedHash = computeRecordHash(current);
      if (current.hash !== expectedHash) {
        return {
          ok: false,
          error: "Tampered record",
          index: i,
          recordId: current.id,
        };
      }

      expectedPrevHash = current.hash;
      expectedSeq++;
    }

    /* Meta validation */
    if (meta.lastHash !== expectedPrevHash) {
      return {
        ok: false,
        error: "Meta hash mismatch",
      };
    }

    if (meta.lastSequence !== logs.length) {
      return {
        ok: false,
        error: "Meta sequence mismatch",
      };
    }

    return {
      ok: true,
      totalRecords: logs.length,
      lastHash: meta.lastHash,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
    };
  }
}

/* =========================================================
   BACKWARD COMPATIBILITY LAYER
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
