const fs = require("fs");
const path = require("path");

const VISITOR_PATH =
  process.env.VISITOR_DATA_PATH ||
  path.join("/tmp", "visitor_data.json");

let data = {
  visits: [],
};

function load() {
  try {
    if (fs.existsSync(VISITOR_PATH)) {
      data = JSON.parse(fs.readFileSync(VISITOR_PATH, "utf-8"));
    }
  } catch {
    data = { visits: [] };
  }
}

function save() {
  try {
    fs.writeFileSync(VISITOR_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

load();

/* =========================================
   TRACK VISIT
========================================= */

function trackVisit({ ip, userAgent, country, path }) {
  const visit = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2),
    ts: Date.now(),
    iso: new Date().toISOString(),
    ip,
    userAgent,
    country: country || "unknown",
    path,
  };

  data.visits.push(visit);

  if (data.visits.length > 5000) {
    data.visits = data.visits.slice(-5000);
  }

  save();
}

/* =========================================
   GET ANALYTICS
========================================= */

function getStats() {
  const total = data.visits.length;

  const byCountry = {};
  const byPath = {};

  data.visits.forEach((v) => {
    byCountry[v.country] = (byCountry[v.country] || 0) + 1;
    byPath[v.path] = (byPath[v.path] || 0) + 1;
  });

  return {
    totalVisits: total,
    byCountry,
    byPath,
  };
}

module.exports = {
  trackVisit,
  getStats,
};
