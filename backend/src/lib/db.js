// backend/src/lib/db.js
// Enterprise DB — Phase 22 Compliance Layer
// Atomic Writes • Financial Ledger • Audit Hash Chain • Retention Policies

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";

const SCHEMA_VERSION = 9;

/* ======================================================
   UTIL
====================================================== */

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

/* ======================================================
   DEFAULT DB
====================================================== */

function defaultDb() {
  return {
    schemaVersion: SCHEMA_VERSION,

    /* ================= CORE ================= */

    users: [],
    companies: [],
    notifications: [],
    scans: [],
    scanCredits: [],
    processedStripeEvents: [],

    /* ================= AUDIT ================= */

    audit: [],
    auditMeta: {
      lastHash: null,
      lastSequence: 0,
      integrityVersion: 1,
    },

    /* ================= FINANCIAL LEDGER ================= */

    invoices: [],
    payments: [],
    refunds: [],
    disputes: [],

    revenueSummary: {
      totalRevenue: 0,
      autoprotekRevenue: 0,
      subscriptionRevenue: 0,
      toolRevenue: 0,
      refundedAmount: 0,
      disputedAmount: 0,
    },

    /* ================= AUTOPROTECT ================= */

    autoprotek: {
      users: {},
    },

    /* ================= COMPLIANCE ================= */

    complianceSnapshots: [],
    retentionPolicy: {
      auditRetentionDays: 365 * 2,
      financialRetentionDays: 365 * 7,
      snapshotRetentionDays: 365 * 3,
    },

    /* ================= OTHER SYSTEMS ================= */

    brain: {
      memory: [],
      notes: [],
    },

    paper: {
      summary: {
        startBalance: 0,
        balance: 0,
        pnl: 0,
        wins: 0,
        losses: 0,
        totalGain: 0,
        totalLoss: 0,
        fees: 0,
        slippage: 0,
        spread: 0,
        lastTradeTs: 0,
      },
      trades: [],
      daily: [],
    },

    live: {
      events: [],
    },
  };
}

/* ======================================================
   MIGRATION
====================================================== */

function migrate(db) {
  if (!db || typeof db !== "object") return defaultDb();

  if (!db.schemaVersion) db.schemaVersion = 1;

  /* Ensure arrays */

  const arrayFields = [
    "users",
    "companies",
    "notifications",
    "scans",
    "scanCredits",
    "processedStripeEvents",
    "audit",
    "invoices",
    "payments",
    "refunds",
    "disputes",
    "complianceSnapshots",
  ];

  for (const field of arrayFields) {
    if (!Array.isArray(db[field])) db[field] = [];
  }

  /* Revenue summary */

  if (!db.revenueSummary || typeof db.revenueSummary !== "object") {
    db.revenueSummary = {
      totalRevenue: 0,
      autoprotekRevenue: 0,
      subscriptionRevenue: 0,
      toolRevenue: 0,
      refundedAmount: 0,
      disputedAmount: 0,
    };
  }

  db.revenueSummary.refundedAmount = db.revenueSummary.refundedAmount || 0;
  db.revenueSummary.disputedAmount = db.revenueSummary.disputedAmount || 0;

  /* Audit metadata */

  if (!db.auditMeta || typeof db.auditMeta !== "object") {
    db.auditMeta = {
      lastHash: null,
      lastSequence: 0,
      integrityVersion: 1,
    };
  }

  /* Autoprotect */

  if (!db.autoprotek || typeof db.autoprotek !== "object") {
    db.autoprotek = { users: {} };
  }

  if (!db.autoprotek.users) db.autoprotek.users = {};

  /* Retention policy */

  if (!db.retentionPolicy) {
    db.retentionPolicy = {
      auditRetentionDays: 365 * 2,
      financialRetentionDays: 365 * 7,
      snapshotRetentionDays: 365 * 3,
    };
  }

  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

/* ======================================================
   CORE IO
====================================================== */

function ensureDb() {
  ensureDir(DB_PATH);

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
    return;
  }

  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const migrated = migrate(parsed);
    fs.writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2));
  } catch {
    try {
      const bad = fs.readFileSync(DB_PATH, "utf-8");
      fs.writeFileSync(DB_PATH + ".corrupt." + Date.now(), bad);
    } catch {}

    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return migrate(JSON.parse(fs.readFileSync(DB_PATH, "utf-8")));
}

function writeDb(db) {
  const safe = migrate(db);

  fs.writeFileSync(TMP_PATH, JSON.stringify(safe, null, 2));
  fs.renameSync(TMP_PATH, DB_PATH);
}

function updateDb(mutator) {
  const db = readDb();
  const out = mutator(db) || db;
  writeDb(out);
  return out;
}

/* ======================================================
   EXPORTS
====================================================== */

module.exports = {
  DB_PATH,
  TMP_PATH,
  SCHEMA_VERSION,
  ensureDb,
  readDb,
  writeDb,
  updateDb,

  // optional exports (safe to keep)
  migrate,
  defaultDb,
};
