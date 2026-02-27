// backend/src/middleware/rateLimiter.js
// Enterprise Traffic Shield — Burst + Sliding Window (Hardened v2)
// IP + Token Hybrid • Auto Block • Memory Bounded • Abuse Telemetry Safe

const crypto = require("crypto");
const { writeAudit } = require("../lib/audit");

const WINDOW_MS = 60 * 1000;      // 1 minute
const MAX_REQUESTS = 120;
const BURST_LIMIT = 40;
const BURST_WINDOW = 10 * 1000;
const BLOCK_TIME = 5 * 60 * 1000;

const CLEANUP_INTERVAL = 60 * 1000;
const MAX_STORE_SIZE = 5000;

const ipStore = new Map();

/* ========================================================= */

function now() {
  return Date.now();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function getKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  const token = req.headers.authorization || "";
  if (!token) return ip;

  return `${ip}|${hashToken(token)}`;
}

/* =========================================================
   CLEANUP
========================================================= */

function cleanupStore() {
  const current = now();

  for (const [key, entry] of ipStore.entries()) {
    const expiredBlock =
      !entry.blockedUntil || entry.blockedUntil <= current;

    const empty =
      entry.timestamps.length === 0 &&
      entry.burst.length === 0;

    if (expiredBlock && empty) {
      ipStore.delete(key);
    }
  }

  // Hard cap protection
  if (ipStore.size > MAX_STORE_SIZE) {
    const keys = Array.from(ipStore.keys());
    for (let i = 0; i < keys.length - MAX_STORE_SIZE; i++) {
      ipStore.delete(keys[i]);
    }
  }
}

setInterval(cleanupStore, CLEANUP_INTERVAL);

/* ========================================================= */

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
