// backend/src/lib/db.js
// Enterprise DB — Phase 25 Tool Governance Layer

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";

const SCHEMA_VERSION = 12; // 🔥 bumped

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultDb() {
  return {
    schemaVersion: SCHEMA_VERSION,

    /* CORE */
    users: [],
    companies: [],
    notifications: [],

    /* 🔥 TOOL GOVERNANCE LAYER */
    tools: [],                // master tool registry
    toolRequests: [],         // approval workflow
    entitlements: [],         // temporary access grants

    /* ASSETS */
    assets: [],

    /* SECURITY */
    incidents: [],
    vulnerabilities: [],
    securityEvents: [],

    systemState: {
      securityStatus: "NORMAL",
      lastComplianceCheck: null,
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

function migrate(db) {
  if (!db || typeof db !== "object") return defaultDb();
  if (!db.schemaVersion) db.schemaVersion = 1;

  const arrayFields = [
    "users",
    "companies",
    "notifications",

    /* 🔥 TOOL LAYER */
    "tools",
    "toolRequests",
    "entitlements",

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

  if (!db.systemState)
    db.systemState = {
      securityStatus: "NORMAL",
      lastComplianceCheck: null,
    };

  if (!db.revenueSummary)
    db.revenueSummary = {
      totalRevenue: 0,
      autoprotekRevenue: 0,
      subscriptionRevenue: 0,
      toolRevenue: 0,
      refundedAmount: 0,
      disputedAmount: 0,
    };

  if (!db.auditMeta)
    db.auditMeta = {
      lastHash: null,
      lastSequence: 0,
      integrityVersion: 1,
    };

  if (!db.autoprotek) db.autoprotek = { users: {} };

  if (!db.retentionPolicy)
    db.retentionPolicy = {
      auditRetentionDays: 365 * 2,
      financialRetentionDays: 365 * 7,
      snapshotRetentionDays: 365 * 3,
    };

  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

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

module.exports = {
  DB_PATH,
  ensureDb,
  readDb,
  writeDb,
  updateDb,
};
