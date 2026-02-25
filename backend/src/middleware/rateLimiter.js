// backend/src/middleware/rateLimiter.js
// Enterprise Traffic Shield — Burst + Sliding Window
// IP + Token Hybrid • Auto Block • Abuse Telemetry

const { writeAudit } = require("../lib/audit");

const WINDOW_MS = 60 * 1000;      // 1 minute window
const MAX_REQUESTS = 120;         // per window
const BURST_LIMIT = 40;           // 10-second burst
const BURST_WINDOW = 10 * 1000;
const BLOCK_TIME = 5 * 60 * 1000; // 5 minutes

const ipStore = new Map();

function now() {
  return Date.now();
}

function getKey(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const token = req.headers.authorization || "";
  return token ? `${ip}|${token.slice(-12)}` : ip;
}

function rateLimiter(req, res, next) {
  const key = getKey(req);
  const currentTime = now();

  if (!ipStore.has(key)) {
    ipStore.set(key, {
      timestamps: [],
      burst: [],
      blockedUntil: null,
    });
  }

  const entry = ipStore.get(key);

  /* ================= BLOCK CHECK ================= */

  if (entry.blockedUntil && entry.blockedUntil > currentTime) {
    return res.status(429).json({
      ok: false,
      error: "Too many requests. Temporarily blocked."
    });
  }

  /* ================= CLEAN OLD ================= */

  entry.timestamps = entry.timestamps.filter(
    t => currentTime - t < WINDOW_MS
  );

  entry.burst = entry.burst.filter(
    t => currentTime - t < BURST_WINDOW
  );

  /* ================= ADD REQUEST ================= */

  entry.timestamps.push(currentTime);
  entry.burst.push(currentTime);

  /* ================= BURST DETECTION ================= */

  if (entry.burst.length > BURST_LIMIT) {
    entry.blockedUntil = currentTime + BLOCK_TIME;

    writeAudit({
      actor: "traffic_shield",
      role: "system",
      action: "RATE_LIMIT_BURST_BLOCK",
      detail: { key }
    });

    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded (burst)"
    });
  }

  /* ================= WINDOW LIMIT ================= */

  if (entry.timestamps.length > MAX_REQUESTS) {
    entry.blockedUntil = currentTime + BLOCK_TIME;

    writeAudit({
      actor: "traffic_shield",
      role: "system",
      action: "RATE_LIMIT_WINDOW_BLOCK",
      detail: { key }
    });

    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded"
    });
  }

  return next();
}

module.exports = rateLimiter;
