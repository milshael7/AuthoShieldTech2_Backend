// AutoShield Tech — Enterprise Immutable Audit Ledger v40
// Hash Chain • Snapshot Anchors • Version Enforcement • Truncation Guard • Bounded Growth

const crypto = require("crypto");
const { updateDb, readDb } = require("./db");

/* =========================================================
   CONSTANTS
========================================================= */

const GENESIS_HASH = "GENESIS";
const INTEGRITY_VERSION = 3;
const SNAPSHOT_INTERVAL = 1000;
const MAX_SNAPSHOTS = 500;          // 🔒 bounded memory
const MAX_AUDIT_RECORDS = 250000;   // 🔒 hard cap safety

/* =========================================================
   HASH UTIL
========================================================= */

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeRecordHash(record) {
  const base = JSON.stringify({
    v: INTEGRITY_VERSION,
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
   WRITE AUDIT
========================================================= */

function writeAudit(input = {}) {
  try {
    const db = readDb();

    if (!Array.isArray(db.audit)) db.audit = [];

    if (!db.auditMeta) {
      db.auditMeta = {
        lastHash: null,
        lastSequence: 0,
        integrityVersion: INTEGRITY_VERSION,
        snapshots: [],
      };
    }

    const prevHash = db.auditMeta.lastHash || GENESIS_HASH;
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
          integrityVersion: INTEGRITY_VERSION,
          snapshots: [],
        };
      }

      db2.audit.push(record);

      /* 🔒 Hard cap safety */
      if (db2.audit.length > MAX_AUDIT_RECORDS) {
        db2.audit = db2.audit.slice(-MAX_AUDIT_RECORDS);
      }

      db2.auditMeta.lastHash = record.hash;
      db2.auditMeta.lastSequence = seq;
      db2.auditMeta.integrityVersion = INTEGRITY_VERSION;

      /* Snapshot Anchoring */
      if (seq % SNAPSHOT_INTERVAL === 0) {
        db2.auditMeta.snapshots.push({
          seq,
          hash: record.hash,
          ts: Date.now(),
        });

        /* 🔒 Snapshot bound */
        if (db2.auditMeta.snapshots.length > MAX_SNAPSHOTS) {
          db2.auditMeta.snapshots =
            db2.auditMeta.snapshots.slice(-MAX_SNAPSHOTS);
        }
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
    const meta = db.auditMeta || {};

    if (logs.length === 0) {
      return { ok: true, message: "No audit records" };
    }

    if (meta.integrityVersion !== INTEGRITY_VERSION) {
      return {
        ok: false,
        error: "Integrity version mismatch",
      };
    }

    let expectedPrevHash = GENESIS_HASH;
    let expectedSeq = 1;

    for (let i = 0; i < logs.length; i++) {
      const current = logs[i];

      if (current.seq !== expectedSeq) {
        return { ok: false, error: "Sequence mismatch", index: i };
      }

      if (current.prevHash !== expectedPrevHash) {
        return { ok: false, error: "Broken hash chain", index: i };
      }

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
        error: "Meta hash mismatch (possible truncation)",
      };
    }

    if (meta.lastSequence !== logs.length) {
      return {
        ok: false,
        error: "Meta sequence mismatch",
      };
    }

    /* Snapshot validation */
    if (Array.isArray(meta.snapshots)) {
      for (const snap of meta.snapshots) {
        if (snap.seq > logs.length) {
          return {
            ok: false,
            error: "Snapshot beyond log length (truncation detected)",
          };
        }

        const record = logs[snap.seq - 1];
        if (!record || record.hash !== snap.hash) {
          return {
            ok: false,
            error: "Snapshot anchor mismatch",
            seq: snap.seq,
          };
        }
      }
    }

    return {
      ok: true,
      totalRecords: logs.length,
      lastHash: meta.lastHash,
      integrityVersion: meta.integrityVersion,
    };

  } catch (err) {
    return {
      ok: false,
      error: err.message,
    };
  }
}

/* =========================================================
   BACKWARD COMPATIBILITY WRAPPER
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
