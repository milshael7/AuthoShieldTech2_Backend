const fs = require("fs");
const path = require("path");

const ANALYTICS_PATH =
  process.env.ANALYTICS_PATH ||
  path.join("/tmp", "visitor_analytics.json");

let state = {
  createdAt: new Date().toISOString(),
  visitors: [],
};

function safeLoad() {
  try {
    if (fs.existsSync(ANALYTICS_PATH)) {
      state = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf-8"));
    }
  } catch {
    state = { createdAt: new Date().toISOString(), visitors: [] };
  }
}

function safeSave() {
  try {
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(state, null, 2));
  } catch {}
}

safeLoad();

/* =============================================
   RECORD EVENT
============================================= */

function recordVisit(event) {
  const entry = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    iso: new Date().toISOString(),
    ...event,
  };

  state.visitors.push(entry);

  if (state.visitors.length > 5000) {
    state.visitors = state.visitors.slice(-5000);
  }

  safeSave();
  return entry;
}

/* =============================================
   SUMMARY
============================================= */

function getSummary() {
  const total = state.visitors.length;

  const today = new Date().toDateString();

  const todayCount = state.visitors.filter(
    (v) => new Date(v.ts).toDateString() === today
  ).length;

  const byCountry = {};

  state.visitors.forEach((v) => {
    const country = v.country || "Unknown";
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return {
    totalVisits: total,
    todayVisits: todayCount,
    byCountry,
  };
}

module.exports = {
  recordVisit,
  getSummary,
};
