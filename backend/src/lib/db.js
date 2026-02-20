// backend/src/lib/db.js
// File-based JSON DB with schema + safe writes (atomic)
// Fully Hardened • Stripe Ready • Scan Credit Ready • AutoProtect Ready

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";

const SCHEMA_VERSION = 6;

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

    users: [],
    companies: [],
    audit: [],
    notifications: [],
    scans: [],
    scanCredits: {},
    processedStripeEvents: [],

    /* ======================================================
       🔥 AUTOPROTECT (User Scoped)
    ====================================================== */

    autoprotek: {
      users: {
        /*
        USER_ID: {
          status: "ACTIVE" | "INACTIVE",
          activatedAt: "",
          expiresAt: "",
          monthlyJobLimit: 30,
          jobsUsedThisMonth: 0,
          lastResetMonth: "2026-02",

          companies: {
            COMPANY_ID: {
              schedule: {
                timezone: "",
                workingDays: [],
                startTime: "",
                endTime: ""
              },
              vacation: {
                from: "",
                to: ""
              },
              email: "",
              jobs: [],
              reports: [],
              emailDrafts: [],
              emailSent: []
            }
          }
        }
        */
      }
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

  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.companies)) db.companies = [];
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
  if (!Array.isArray(db.scans)) db.scans = [];

  if (!db.scanCredits || typeof db.scanCredits !== "object") {
    db.scanCredits = {};
  }

  if (!Array.isArray(db.processedStripeEvents)) {
    db.processedStripeEvents = [];
  }

  /* ======================================================
     🔥 AUTOPROTECT MIGRATION
  ====================================================== */

  if (!db.autoprotek || typeof db.autoprotek !== "object") {
    db.autoprotek = { users: {} };
  }

  if (!db.autoprotek.users || typeof db.autoprotek.users !== "object") {
    db.autoprotek.users = {};
  }

  for (const userId of Object.keys(db.autoprotek.users)) {
    const userContainer = db.autoprotek.users[userId];

    if (!userContainer.status) userContainer.status = "INACTIVE";
    if (!userContainer.monthlyJobLimit)
      userContainer.monthlyJobLimit = 30;
    if (!userContainer.jobsUsedThisMonth)
      userContainer.jobsUsedThisMonth = 0;
    if (!userContainer.lastResetMonth)
      userContainer.lastResetMonth = "";

    if (!userContainer.companies)
      userContainer.companies = {};

    for (const companyId of Object.keys(userContainer.companies)) {
      const c = userContainer.companies[companyId];

      if (!c.schedule)
        c.schedule = {
          timezone: "",
          workingDays: [],
          startTime: "",
          endTime: "",
        };

      if (!c.vacation)
        c.vacation = {
          from: "",
          to: "",
        };

      if (!Array.isArray(c.jobs)) c.jobs = [];
      if (!Array.isArray(c.reports)) c.reports = [];
      if (!Array.isArray(c.emailDrafts)) c.emailDrafts = [];
      if (!Array.isArray(c.emailSent)) c.emailSent = [];
    }
  }

  if (!db.brain) db.brain = {};
  if (!Array.isArray(db.brain.memory)) db.brain.memory = [];
  if (!Array.isArray(db.brain.notes)) db.brain.notes = [];

  if (!db.paper) db.paper = {};
  if (!db.paper.summary) {
    db.paper.summary = {
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
    };
  }

  if (!Array.isArray(db.paper.trades)) db.paper.trades = [];
  if (!Array.isArray(db.paper.daily)) db.paper.daily = [];

  if (!db.live) db.live = {};
  if (!Array.isArray(db.live.events)) db.live.events = [];

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

function writeAudit(event = {}) {
  try {
    updateDb((db) => {
      db.audit.push({
        ts: now(),
        actorId: event.actorId || "system",
        actorRole: event.actorRole || "system",
        companyId: event.companyId || null,
        action: String(event.action || "unknown").slice(0, 120),
        target: String(event.target || "").slice(0, 120),
        meta: event.meta || {},
      });

      if (db.audit.length > 5000) {
        db.audit = db.audit.slice(-4000);
      }
    });
  } catch (e) {
    console.error("AUDIT WRITE FAILED:", e);
  }
}

module.exports = {
  DB_PATH,
  ensureDb,
  readDb,
  writeDb,
  updateDb,
  writeAudit,
};
