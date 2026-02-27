// backend/src/lib/db.js
// AutoShield Tech — Enterprise DB Core v26
// Atomic Writes • Backup Safety • Migration Hardened • ZeroTrust Ready

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";
const BACKUP_PATH = DB_PATH + ".bak";

const SCHEMA_VERSION = 14; // 🔥 upgraded for ZeroTrust + integrity hardening
const MAX_COMPANY_RISK_HISTORY = 50;

/* =========================================================
   UTIL
========================================================= */

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* =========================================================
   DEFAULT DB
========================================================= */

function defaultDb() {
  return {
    schemaVersion: SCHEMA_VERSION,

    /* CORE */
    users: [],
    companies: [],
    notifications: [],

    /* TOOL GOVERNANCE */
    tools: [],
    toolRequests: [],
    toolGrants: [],

    /* ASSETS */
    assets: [],

    /* SECURITY */
    incidents: [],
    vulnerabilities: [],
    securityEvents: [],

    systemState: {
      securityStatus: "NORMAL",
      lastComplianceCheck: null,
      lastZeroTrustRun: null,
    },

    scans: [],
    scanCredits: [],
    processedStripeEvents: [],

    audit: [],
    auditMeta: {
      lastHash: null,
      lastSequence: 0,
      integrityVersion: 1,
    },

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

    autoprotek: { users: {} },

    complianceSnapshots: [],

    retentionPolicy: {
      auditRetentionDays: 365 * 2,
      financialRetentionDays: 365 * 7,
      snapshotRetentionDays: 365 * 3,
    },

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

    live: { events: [] },
  };
}

/* =========================================================
   MIGRATION
========================================================= */

function migrate(db) {
  if (!db || typeof db !== "object") return defaultDb();
  if (!db.schemaVersion) db.schemaVersion = 1;

  /* Backward compatibility: entitlements → toolGrants */
  if (Array.isArray(db.entitlements) && !Array.isArray(db.toolGrants)) {
    db.toolGrants = db.entitlements;
  }

  const arrayFields = [
    "users",
    "companies",
    "notifications",
    "tools",
    "toolRequests",
    "toolGrants",
    "assets",
    "scans",
    "scanCredits",
    "processedStripeEvents",
    "audit",
    "invoices",
    "payments",
    "refunds",
    "disputes",
    "complianceSnapshots",
    "incidents",
    "vulnerabilities",
    "securityEvents",
  ];

  for (const field of arrayFields) {
    if (!Array.isArray(db[field])) db[field] = [];
  }

  /* Ensure systemState */
  if (!db.systemState) {
    db.systemState = {
      securityStatus: "NORMAL",
      lastComplianceCheck: null,
      lastZeroTrustRun: null,
    };
  }

  /* Ensure company ZeroTrust fields */
  for (const company of db.companies) {
    if (!company.enforcementThreshold)
      company.enforcementThreshold = 75;

    if (!Array.isArray(company.riskHistory))
      company.riskHistory = [];

    if (company.riskHistory.length > MAX_COMPANY_RISK_HISTORY) {
      company.riskHistory =
        company.riskHistory.slice(-MAX_COMPANY_RISK_HISTORY);
    }
  }

  if (!db.revenueSummary) {
    db.revenueSummary = defaultDb().revenueSummary;
  }

  if (!db.auditMeta) {
    db.auditMeta = {
      lastHash: null,
      lastSequence: 0,
      integrityVersion: 1,
    };
  }

  if (!db.autoprotek) db.autoprotek = { users: {} };

  if (!db.retentionPolicy)
    db.retentionPolicy = defaultDb().retentionPolicy;

  db.schemaVersion = SCHEMA_VERSION;

  return db;
}

/* =========================================================
   CORE FILE OPS (ATOMIC SAFE)
========================================================= */

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
    writeDb(migrated);
  } catch (err) {
    console.error("[DB] Corruption detected. Restoring default.");
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function readDb() {
  ensureDb();

  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.error("[DB] Read failure. Attempting backup restore.");
    if (fs.existsSync(BACKUP_PATH)) {
      const raw = fs.readFileSync(BACKUP_PATH, "utf-8");
      return migrate(JSON.parse(raw));
    }
    return defaultDb();
  }
}

function writeDb(db) {
  const safe = migrate(deepClone(db));

  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(safe, null, 2));

    // backup current DB before overwrite
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, BACKUP_PATH);
    }

    fs.renameSync(TMP_PATH, DB_PATH);

  } catch (err) {
    console.error("[DB] Atomic write failed:", err);
    throw err;
  }
}

function updateDb(mutator) {
  const db = readDb();
  const out = mutator(db) || db;
  writeDb(out);
  return out;
}

module.exports = {
  DB_PATH,
  ensureDb,
  readDb,
  writeDb,
  updateDb,
};
