// Immutable Revenue Ledger — Financial Hash Chain v1
// Deterministic • Tamper Detecting • Stripe Compatible • Audit Anchored

const crypto = require("crypto");
const { readDb, writeDb } = require("./db");
const { writeAudit } = require("./audit");

const GENESIS_HASH = "REVENUE_GENESIS";
const LEDGER_VERSION = 1;

/* ========================================================= */

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function computeLedgerHash(entry) {
  const base = JSON.stringify({
    v: LEDGER_VERSION,
    seq: entry.seq,
    ts: entry.ts,
    type: entry.type,
    amount: entry.amount,
    currency: entry.currency,
    userId: entry.userId,
    invoiceId: entry.invoiceId,
    prevHash: entry.prevHash,
  });

  return sha256(base);
}

/* ========================================================= */

function appendRevenueEntry({
  type,
  amount,
  currency = "usd",
  userId = null,
  invoiceId = null
}) {
  const db = readDb();

  if (!Array.isArray(db.revenueLedger))
    db.revenueLedger = [];

  if (!db.revenueMeta) {
    db.revenueMeta = {
      lastHash: null,
      lastSequence: 0,
      version: LEDGER_VERSION
    };
  }

  const prevHash = db.revenueMeta.lastHash || GENESIS_HASH;
  const seq = db.revenueMeta.lastSequence + 1;

  const entry = {
    id: crypto.randomUUID(),
    seq,
    ts: Date.now(),
    type,
    amount: Number(amount),
    currency,
    userId,
    invoiceId,
    prevHash,
    hash: null
  };

  entry.hash = computeLedgerHash(entry);

  db.revenueLedger.push(entry);

  db.revenueMeta.lastHash = entry.hash;
  db.revenueMeta.lastSequence = seq;
  db.revenueMeta.version = LEDGER_VERSION;

  writeDb(db);

  writeAudit({
    actor: "system_finance",
    role: "system",
    action: "REVENUE_LEDGER_APPEND",
    detail: {
      seq,
      type,
      amount,
      currency
    }
  });

  return entry;
}

/* ========================================================= */

function verifyRevenueLedger() {
  const db = readDb();
  const logs = db.revenueLedger || [];
  const meta = db.revenueMeta || {};

  if (logs.length === 0) {
    return { ok: true, message: "No ledger entries" };
  }

  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (let i = 0; i < logs.length; i++) {
    const current = logs[i];

    if (current.seq !== expectedSeq) {
      return { ok: false, error: "Sequence mismatch", index: i };
    }

    if (current.prevHash !== expectedPrevHash) {
      return { ok: false, error: "Broken ledger chain", index: i };
    }

    const expectedHash = computeLedgerHash(current);
    if (current.hash !== expectedHash) {
      return {
        ok: false,
        error: "Tampered revenue entry",
        index: i
      };
    }

    expectedPrevHash = current.hash;
    expectedSeq++;
  }

  if (meta.lastHash !== expectedPrevHash) {
    return { ok: false, error: "Meta hash mismatch" };
  }

  return {
    ok: true,
    totalEntries: logs.length,
    lastHash: meta.lastHash
  };
}

module.exports = {
  appendRevenueEntry,
  verifyRevenueLedger
};
