// backend/src/lib/db.js
// File-based JSON DB with schema + safe writes (atomic)

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const TMP_PATH = DB_PATH + '.tmp';

const SCHEMA_VERSION = 4;

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

    // 🔥 NEW
    tools: [],
    scans: [],

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
  if (!db || typeof db !== 'object') return defaultDb();

  if (!db.schemaVersion) db.schemaVersion = 1;

  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.companies)) db.companies = [];
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];

  // 🔥 NEW
  if (!Array.isArray(db.tools)) db.tools = [];
  if (!Array.isArray(db.scans)) db.scans = [];

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
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrate(parsed);
    fs.writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2));
  } catch {
    try {
      const bad = fs.readFileSync(DB_PATH, 'utf-8');
      fs.writeFileSync(DB_PATH + '.corrupt.' + Date.now(), bad);
    } catch {}
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return migrate(JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')));
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
   AUDIT WRITES
====================================================== */

function writeAudit(event = {}) {
  try {
    updateDb((db) => {
      db.audit.push({
        ts: now(),
        actorId: event.actorId || 'system',
        actorRole: event.actorRole || 'system',
        companyId: event.companyId || null,
        action: String(event.action || 'unknown').slice(0, 120),
        target: String(event.target || '').slice(0, 120),
        meta: event.meta || {},
      });

      if (db.audit.length > 5000) {
        db.audit = db.audit.slice(-4000);
      }
    });
  } catch (e) {
    console.error('AUDIT WRITE FAILED:', e);
  }
}

/* ======================================================
   EXPORTS
====================================================== */

module.exports = {
  DB_PATH,
  ensureDb,
  readDb,
  writeDb,
  updateDb,
  writeAudit,
};
