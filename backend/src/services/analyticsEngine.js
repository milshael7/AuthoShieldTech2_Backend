const fs = require("fs");
const path = require("path");

/* =========================================================
   ANALYTICS ENGINE
   PURPOSE
   ---------------------------------------------------------
   Durable visitor analytics storage + reporting engine.

   MAINTENANCE SAFE FEATURES
   ---------------------------------------------------------
   - Persistent file storage
   - Auto directory creation
   - Safe boot recovery
   - State normalization
   - Backup before risky writes
   - Readable helper structure
   - Daily / weekly / monthly / yearly / all-time summaries
   - Chart-ready trend series
   - Easy future extension for maintenance work
========================================================= */

const ANALYTICS_PATH =
  process.env.ANALYTICS_PATH ||
  path.join(process.cwd(), "storage", "visitor_analytics.json");

const ANALYTICS_BACKUP_PATH =
  process.env.ANALYTICS_BACKUP_PATH ||
  path.join(process.cwd(), "storage", "visitor_analytics.backup.json");

const MAX_VISITORS = Number(process.env.ANALYTICS_MAX_VISITORS || 50000);

/* =========================================================
   IN-MEMORY STATE
========================================================= */

let state = createEmptyState();

/* =========================================================
   STATE BUILDERS
========================================================= */

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
   FILESYSTEM SAFETY
========================================================= */

function ensureDirForFile(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function safeBackup() {
  try {
    if (!fileExists(ANALYTICS_PATH)) return;
    ensureDirForFile(ANALYTICS_BACKUP_PATH);
    fs.copyFileSync(ANALYTICS_PATH, ANALYTICS_BACKUP_PATH);
  } catch {}
}

/* =========================================================
   LOAD / SAVE
========================================================= */

function safeLoad() {
  try {
    ensureDirForFile(ANALYTICS_PATH);

    if (fileExists(ANALYTICS_PATH)) {
      state = normalizeState(readJsonFile(ANALYTICS_PATH));
      return;
    }

    state = createEmptyState();
    safeSave({ skipBackup: true });
  } catch {
    try {
      if (fileExists(ANALYTICS_BACKUP_PATH)) {
        state = normalizeState(readJsonFile(ANALYTICS_BACKUP_PATH));
        safeSave({ skipBackup: true });
        return;
      }
    } catch {}

    state = createEmptyState();
    safeSave({ skipBackup: true });
  }
}

function safeSave(options = {}) {
  const { skipBackup = false } = options;

  try {
    if (!skipBackup && fileExists(ANALYTICS_PATH)) {
      safeBackup();
    }

    state.updatedAt = new Date().toISOString();
    writeJsonFile(ANALYTICS_PATH, state);
  } catch {}
}

safeLoad();

/* =========================================================
   GENERIC HELPERS
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function clampDuration(v) {
  const n = safeNum(v, 0);
  if (n < 0) return 0;
  return Math.min(n, 24 * 60 * 60 * 1000);
}

function toDate(value) {
  if (value === undefined || value === null) return null;

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const n = Number(value);
  if (Number.isFinite(n)) {
    const parsed = new Date(n);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function sortObjectDesc(input) {
  return Object.fromEntries(
    Object.entries(input).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]).localeCompare(String(b[0]));
    })
  );
}

/* =========================================================
   BUCKET HELPERS
========================================================= */

function createBucket() {
  return {
    visits: 0,
    totalDuration: 0,
    avgDuration: 0,
  };
}

function addVisitToBucket(bucket, visit) {
  bucket.visits += 1;
  bucket.totalDuration += clampDuration(visit?.duration);
}

function finalizeBucket(bucket) {
  const visits = safeNum(bucket.visits, 0);
  const totalDuration = safeNum(bucket.totalDuration, 0);

  return {
    visits,
    totalDuration,
    avgDuration: visits > 0 ? totalDuration / visits : 0,
  };
}

/* =========================================================
   VISITOR NORMALIZATION
========================================================= */

function normalizeVisit(event = {}) {
  const now = Date.now();

  return {
    id:
      safeText(event.id) ||
      `${now}_${Math.random().toString(16).slice(2)}`,
    ts: safeNum(event.ts, now),
    iso: safeText(event.iso) || new Date(now).toISOString(),
    path: safeText(event.path, "/"),
    duration: clampDuration(event.duration),
    country: safeText(event.country, "Unknown"),
    referrer: safeText(event.referrer, "Direct"),
    userAgent: safeText(event.userAgent, "Unknown"),
    ip: safeText(event.ip, ""),
    source: safeText(event.source, "web"),
    type: safeText(event.type, "visit"),
  };
}

/* =========================================================
   RECORD EVENT
========================================================= */

function recordVisit(event = {}) {
  const entry = normalizeVisit(event);

  state.visitors.push(entry);

  if (state.visitors.length > MAX_VISITORS) {
    state.visitors = state.visitors.slice(-MAX_VISITORS);
  }

  safeSave();
  return entry;
}

/* =========================================================
   PERIOD BUILDERS
========================================================= */

function buildPeriodSummary(visits, startDate) {
  const bucket = createBucket();

  for (const visit of visits) {
    const d = toDate(visit?.ts ?? visit?.iso);
    if (!d) continue;
    if (d >= startDate) {
      addVisitToBucket(bucket, visit);
    }
  }

  return finalizeBucket(bucket);
}

function buildSeries(visits) {
  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();

  for (const visit of visits) {
    const d = toDate(visit?.ts ?? visit?.iso);
    if (!d) continue;

    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const weekBase = startOfWeek(d);
    const weekKey = `${weekBase.getFullYear()}-${String(weekBase.getMonth() + 1).padStart(2, "0")}-${String(weekBase.getDate()).padStart(2, "0")}`;
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const dailyBucket = dailyMap.get(dayKey) || {
      date: dayKey,
      ...createBucket(),
    };
    addVisitToBucket(dailyBucket, visit);
    dailyMap.set(dayKey, dailyBucket);

    const weeklyBucket = weeklyMap.get(weekKey) || {
      date: weekKey,
      ...createBucket(),
    };
    addVisitToBucket(weeklyBucket, visit);
    weeklyMap.set(weekKey, weeklyBucket);

    const monthlyBucket = monthlyMap.get(monthKey) || {
      date: monthKey,
      ...createBucket(),
    };
    addVisitToBucket(monthlyBucket, visit);
    monthlyMap.set(monthKey, monthlyBucket);
  }

  return {
    daily: Array.from(dailyMap.values())
      .map((item) => ({
        date: item.date,
        ...finalizeBucket(item),
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-31),

    weekly: Array.from(weeklyMap.values())
      .map((item) => ({
        date: item.date,
        ...finalizeBucket(item),
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-16),

    monthly: Array.from(monthlyMap.values())
      .map((item) => ({
        date: item.date,
        ...finalizeBucket(item),
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-12),
  };
}

/* =========================================================
   SUMMARY
========================================================= */

function getSummary() {
  const visits = Array.isArray(state.visitors) ? state.visitors : [];
  const now = new Date();

  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const yearStart = startOfYear(now);

  const byCountry = {};
  const byPath = {};
  const byReferrer = {};
  const byType = {};

  let totalDuration = 0;

  for (const visit of visits) {
    const country = safeText(visit?.country, "Unknown");
    const pathName = safeText(visit?.path, "/");
    const referrer = safeText(visit?.referrer, "Direct");
    const type = safeText(visit?.type, "visit");
    const duration = clampDuration(visit?.duration);

    byCountry[country] = (byCountry[country] || 0) + 1;
    byPath[pathName] = (byPath[pathName] || 0) + 1;
    byReferrer[referrer] = (byReferrer[referrer] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;

    totalDuration += duration;
  }

  const today = buildPeriodSummary(visits, todayStart);
  const week = buildPeriodSummary(visits, weekStart);
  const month = buildPeriodSummary(visits, monthStart);
  const year = buildPeriodSummary(visits, yearStart);

  const allTime = finalizeBucket({
    visits: visits.length,
    totalDuration,
  });

  const series = buildSeries(visits);

  return {
    ok: true,
    meta: {
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      version: state.version,
      storagePath: ANALYTICS_PATH,
      backupPath: ANALYTICS_BACKUP_PATH,
      maxVisitors: MAX_VISITORS,
    },

    totals: {
      totalVisits: visits.length,
      totalDuration,
      avgDuration: visits.length > 0 ? totalDuration / visits.length : 0,
    },

    periods: {
      today,
      week,
      month,
      year,
      allTime,
    },

    breakdowns: {
      byCountry: sortObjectDesc(byCountry),
      byPath: sortObjectDesc(byPath),
      byReferrer: sortObjectDesc(byReferrer),
      byType: sortObjectDesc(byType),
    },

    trends: {
      daily: series.daily,
      weekly: series.weekly,
      monthly: series.monthly,
    },

    recentVisits: visits.slice(-250).reverse(),
  };
}

/* =========================================================
   MAINTENANCE HELPERS
   ---------------------------------------------------------
   These helpers make future maintenance easier.
========================================================= */

function getRawState() {
  return normalizeState(state);
}

function replaceState(nextState) {
  state = normalizeState(nextState);
  safeSave();
  return getRawState();
}

function clearAnalytics() {
  state = createEmptyState();
  safeSave();
  return getRawState();
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  recordVisit,
  getSummary,
  getRawState,
  replaceState,
  clearAnalytics,
};
