const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

/* =========================================================
   ANALYTICS ENGINE (FIXED & PERSISTENT)
   PURPOSE: Durable storage + Real-time event broadcasting.
========================================================= */

// The "Lively" Bus: Export this so server.js can listen for updates
const analyticsEvents = new EventEmitter();

const ANALYTICS_PATH =
  process.env.ANALYTICS_PATH ||
  path.join(process.cwd(), "storage", "visitor_analytics.json");

const ANALYTICS_BACKUP_PATH =
  process.env.ANALYTICS_BACKUP_PATH ||
  path.join(process.cwd(), "storage", "visitor_analytics.backup.json");

const MAX_VISITORS = Number(process.env.ANALYTICS_MAX_VISITORS || 50000);

/* =========================================================
   IN-MEMORY STATE & BOOT
========================================================= */

let state = createEmptyState();

function createEmptyState() {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    updatedAt: now,
    version: 1,
    visitors: [],
  };
}

function normalizeState(input) {
  const src = input && typeof input === "object" ? input : {};
  const visitors = Array.isArray(src.visitors) ? src.visitors : [];
  return {
    createdAt: src.createdAt || new Date().toISOString(),
    updatedAt: src.updatedAt || new Date().toISOString(),
    version: Number.isFinite(Number(src.version)) ? Number(src.version) : 1,
    visitors,
  };
}

/* =========================================================
   FILESYSTEM OPERATIONS
========================================================= */

function ensureDir() {
  const dir = path.dirname(ANALYTICS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeSave(options = {}) {
  const { skipBackup = false } = options;
  try {
    ensureDir();
    
    // Backup existing data before overwriting
    if (!skipBackup && fs.existsSync(ANALYTICS_PATH)) {
      fs.copyFileSync(ANALYTICS_PATH, ANALYTICS_BACKUP_PATH);
    }

    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("CRITICAL: Analytics Save Failed", err);
  }
}

function safeLoad() {
  try {
    ensureDir();
    if (fs.existsSync(ANALYTICS_PATH)) {
      const raw = fs.readFileSync(ANALYTICS_PATH, "utf-8");
      state = normalizeState(JSON.parse(raw));
    } else {
      state = createEmptyState();
      safeSave({ skipBackup: true });
    }
  } catch (err) {
    console.error("Analytics Load Error, attempting backup...", err);
    if (fs.existsSync(ANALYTICS_BACKUP_PATH)) {
      try {
        const raw = fs.readFileSync(ANALYTICS_BACKUP_PATH, "utf-8");
        state = normalizeState(JSON.parse(raw));
      } catch {
        state = createEmptyState();
      }
    }
  }
}

// Initial Load on Boot
safeLoad();

/* =========================================================
   CORE LOGIC
========================================================= */

function normalizeVisit(event = {}) {
  const now = Date.now();
  return {
    id: event.id || `${now}_${Math.random().toString(16).slice(2, 8)}`,
    ts: Number(event.ts) || now,
    iso: event.iso || new Date(now).toISOString(),
    path: String(event.path || "/"),
    duration: Math.max(0, Number(event.duration || 0)),
    country: String(event.country || "Unknown"),
    referrer: String(event.referrer || "Direct"),
    userAgent: String(event.userAgent || "Unknown"),
    ip: String(event.ip || ""),
    source: String(event.source || "web"),
    type: String(event.type || "visit"),
  };
}

function recordVisit(event = {}) {
  const entry = normalizeVisit(event);

  state.visitors.push(entry);

  // Keep within limits
  if (state.visitors.length > MAX_VISITORS) {
    state.visitors = state.visitors.slice(-MAX_VISITORS);
  }

  // Persist to Disk
  safeSave();

  // EMIT EVENT: This makes it "Lively" for the front page
  analyticsEvents.emit("new_event", entry);

  return entry;
}

/* =========================================================
   REPORTING & SUMMARY
========================================================= */

function getSummary() {
  const visits = state.visitors;
  const now = new Date();
  
  // Basic breakdowns
  const byCountry = {};
  const byPath = {};
  
  visits.forEach(v => {
    byCountry[v.country] = (byCountry[v.country] || 0) + 1;
    byPath[v.path] = (byPath[v.path] || 0) + 1;
  });

  return {
    ok: true,
    totalVisits: visits.length,
    breakdowns: { byCountry, byPath },
    recentVisits: visits.slice(-100).reverse(),
    updatedAt: state.updatedAt
  };
}

function getRawState() {
  return state;
}

function clearAnalytics() {
  state = createEmptyState();
  safeSave();
  return state;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  recordVisit,
  getSummary,
  getRawState,
  clearAnalytics,
  analyticsEvents // Important for server.js connection
};
