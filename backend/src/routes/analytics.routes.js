const express = require("express");
const router = express.Router();

const {
  recordVisit,
  getSummary,
  getRawState,
  clearAnalytics,
} = require("../services/analyticsEngine");

/* =========================================================
ANALYTICS ROUTES
PURPOSE
---------------------------------------------------------
Website/page analytics route layer.

This is NOT trading analytics.
This route is for wrapped site analytics such as:
- page visits
- live activity
- daily totals
- weekly totals
- monthly totals
- yearly totals
- referrers
- countries
- pages

MAINTENANCE SAFE
---------------------------------------------------------
- Compatible with upgraded analyticsEngine
- Returns raw + wrapped analytics
- Safe fallback parsing
- Maintenance endpoints included
========================================================= */

/* =========================================================
HELPERS
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

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeEntry(entry = {}) {
  return {
    id: entry.id || null,
    path: safeText(entry.path, "/"),
    duration: safeNum(entry.duration, 0),
    country: safeText(entry.country, "Unknown"),
    referrer: safeText(entry.referrer, "Direct"),
    userAgent: entry.userAgent || null,
    ip: entry.ip || "",
    source: safeText(entry.source, "web"),
    type: safeText(entry.type, "visit"),
    ts: safeNum(entry.ts, Date.now()),
    iso:
      safeText(entry.iso) ||
      new Date(safeNum(entry.ts, Date.now())).toISOString(),
    createdAt:
      entry.createdAt ||
      entry.iso ||
      entry.time ||
      entry.timestamp ||
      new Date().toISOString(),
  };
}

function getEntryTime(entry) {
  const raw =
    entry?.ts ??
    entry?.createdAt ??
    entry?.iso ??
    entry?.time ??
    entry?.timestamp ??
    entry?.date ??
    null;

  if (raw === null || raw === undefined) return null;

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  const n = Number(raw);
  if (Number.isFinite(n)) {
    const dn = new Date(n);
    return Number.isNaN(dn.getTime()) ? null : dn;
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

function finalizeList(list, limit = 20) {
  return asArray(list)
    .slice()
    .sort((a, b) => safeNum(b.count, 0) - safeNum(a.count, 0))
    .slice(0, limit);
}

function emptyBucket(label = null) {
  return {
    label,
    visits: 0,
    uniquePages: 0,
    avgDuration: 0,
    totalDuration: 0,
    topPages: [],
    topCountries: [],
    topReferrers: [],
    topTypes: [],
  };
}

function buildBreakdown(entries) {
  const pageMap = new Map();
  const countryMap = new Map();
  const referrerMap = new Map();
  const typeMap = new Map();

  let totalDuration = 0;

  for (const raw of entries) {
    const entry = normalizeEntry(raw);

    totalDuration += safeNum(entry.duration, 0);

    pageMap.set(entry.path, (pageMap.get(entry.path) || 0) + 1);
    countryMap.set(entry.country, (countryMap.get(entry.country) || 0) + 1);
    referrerMap.set(entry.referrer, (referrerMap.get(entry.referrer) || 0) + 1);
    typeMap.set(entry.type, (typeMap.get(entry.type) || 0) + 1);
  }

  const sortMap = (map) =>
    Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return String(a.name).localeCompare(String(b.name));
      });

  return {
    visits: entries.length,
    uniquePages: pageMap.size,
    avgDuration: entries.length ? totalDuration / entries.length : 0,
    totalDuration,
    topPages: sortMap(pageMap).slice(0, 20),
    topCountries: sortMap(countryMap).slice(0, 20),
    topReferrers: sortMap(referrerMap).slice(0, 20),
    topTypes: sortMap(typeMap).slice(0, 20),
  };
}

function finalizeBucket(bucket) {
  return {
    ...bucket,
    visits: safeNum(bucket.visits, 0),
    uniquePages: safeNum(bucket.uniquePages, 0),
    avgDuration: safeNum(bucket.avgDuration, 0),
    totalDuration: safeNum(bucket.totalDuration, 0),
    topPages: finalizeList(bucket.topPages),
    topCountries: finalizeList(bucket.topCountries),
    topReferrers: finalizeList(bucket.topReferrers),
    topTypes: finalizeList(bucket.topTypes),
  };
}

function extractEntriesFromSummary(summary) {
  if (!summary || typeof summary !== "object") return [];

  if (Array.isArray(summary.recentVisits)) return summary.recentVisits;
  if (Array.isArray(summary.entries)) return summary.entries;
  if (Array.isArray(summary.visits)) return summary.visits;
  if (Array.isArray(summary.events)) return summary.events;

  const rawState = getRawState?.();
  if (Array.isArray(rawState?.visitors)) return rawState.visitors;

  return [];
}

function buildWrappedAnalytics(entriesInput) {
  const entries = asArray(entriesInput).map(normalizeEntry);
  const now = new Date();

  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const yearStart = startOfYear(now);

  const todayEntries = [];
  const weekEntries = [];
  const monthEntries = [];
  const yearEntries = [];

  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();

  for (const entry of entries) {
    const d = getEntryTime(entry);
    if (!d) continue;

    if (d >= todayStart) todayEntries.push(entry);
    if (d >= weekStart) weekEntries.push(entry);
    if (d >= monthStart) monthEntries.push(entry);
    if (d >= yearStart) yearEntries.push(entry);

    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const weekBase = startOfWeek(d);
    const weekKey = `${weekBase.getFullYear()}-${String(weekBase.getMonth() + 1).padStart(2, "0")}-${String(weekBase.getDate()).padStart(2, "0")}`;

    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, []);
    if (!weeklyMap.has(weekKey)) weeklyMap.set(weekKey, []);
    if (!monthlyMap.has(monthKey)) monthlyMap.set(monthKey, []);

    dailyMap.get(dayKey).push(entry);
    weeklyMap.get(weekKey).push(entry);
    monthlyMap.get(monthKey).push(entry);
  }

  const today = finalizeBucket({
    label: "today",
    ...buildBreakdown(todayEntries),
  });

  const week = finalizeBucket({
    label: "week",
    ...buildBreakdown(weekEntries),
  });

  const month = finalizeBucket({
    label: "month",
    ...buildBreakdown(monthEntries),
  });

  const year = finalizeBucket({
    label: "year",
    ...buildBreakdown(yearEntries),
  });

  const allTime = finalizeBucket({
    label: "all-time",
    ...buildBreakdown(entries),
  });

  const daily = Array.from(dailyMap.entries())
    .map(([date, list]) =>
      finalizeBucket({
        date,
        ...buildBreakdown(list),
      })
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-35);

  const weekly = Array.from(weeklyMap.entries())
    .map(([date, list]) =>
      finalizeBucket({
        date,
        ...buildBreakdown(list),
      })
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-20);

  const monthly = Array.from(monthlyMap.entries())
    .map(([date, list]) =>
      finalizeBucket({
        date,
        ...buildBreakdown(list),
      })
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-12);

  return {
    today,
    week,
    month,
    year,
    allTime,
    daily,
    weekly,
    monthly,
    live: {
      online: entries.filter((entry) => {
        const d = getEntryTime(entry);
        return d && Date.now() - d.getTime() <= 5 * 60 * 1000;
      }).length,
      updatedAt: new Date().toISOString(),
    },
  };
}

/* =========================================================
RECORD WEBSITE EVENT
========================================================= */

router.post("/event", (req, res) => {
  try {
    const {
      path,
      duration,
      country,
      referrer,
      source,
      type,
      ip,
    } = req.body || {};

    const entry = recordVisit({
      path,
      duration,
      country,
      referrer,
      source,
      type,
      ip:
        ip ||
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        "",
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      ok: true,
      entry: normalizeEntry(entry),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to record analytics event",
    });
  }
});

/* =========================================================
GET WRAPPED SUMMARY
========================================================= */

router.get("/summary", (req, res) => {
  try {
    const summary = getSummary() || {};
    const rawEntries = extractEntriesFromSummary(summary);
    const wrapped = buildWrappedAnalytics(rawEntries);

    return res.json({
      ok: true,
      summary: {
        raw: summary,
        wrapped,
      },
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to build analytics summary",
    });
  }
});

/* =========================================================
GET REPORTS
---------------------------------------------------------
Same analytics source, but easier frontend access for:
- /api/analytics/reports
========================================================= */

router.get("/reports", (req, res) => {
  try {
    const summary = getSummary() || {};
    const rawEntries = extractEntriesFromSummary(summary);
    const wrapped = buildWrappedAnalytics(rawEntries);

    return res.json({
      ok: true,
      reports: wrapped,
      archive: {
        recent: rawEntries.slice().reverse().slice(0, 500),
      },
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to build analytics reports",
    });
  }
});

/* =========================================================
RAW STATE
---------------------------------------------------------
Helpful for maintenance inspection
========================================================= */

router.get("/state", (req, res) => {
  try {
    const state = getRawState ? getRawState() : { visitors: [] };

    return res.json({
      ok: true,
      state,
      count: Array.isArray(state?.visitors) ? state.visitors.length : 0,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to read analytics state",
    });
  }
});

/* =========================================================
MAINTENANCE CLEAR
---------------------------------------------------------
Use carefully. Clears website analytics memory/file.
========================================================= */

router.post("/maintenance/clear", (req, res) => {
  try {
    const cleared = clearAnalytics ? clearAnalytics() : { visitors: [] };

    return res.json({
      ok: true,
      action: "ANALYTICS_CLEARED",
      state: cleared,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to clear analytics state",
    });
  }
});

module.exports = router;
