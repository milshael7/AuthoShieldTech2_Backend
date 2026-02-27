// backend/src/middleware/rateLimiter.js
// AutoShield Tech — Enterprise Traffic Shield v3
// Burst + Sliding Window • Role Aware • Escalating Blocks • Memory Safe

const crypto = require("crypto");
const { writeAudit } = require("../lib/audit");

const WINDOW_MS = 60 * 1000;
const BURST_WINDOW = 10 * 1000;

const MAX_REQUESTS_BASE = 120;
const BURST_LIMIT_BASE = 40;

const BLOCK_TIME_BASE = 5 * 60 * 1000;
const ESCALATION_MULTIPLIER = 2;

const CLEANUP_INTERVAL = 60 * 1000;
const MAX_STORE_SIZE = 5000;

const ipStore = new Map();

/* ========================================================= */

function now() {
  return Date.now();
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 12);
}

function shouldBypass(req) {
  const path = req.originalUrl || "";

  if (
    path.startsWith("/health") ||
    path.startsWith("/live") ||
    path.startsWith("/ready") ||
    path.startsWith("/api/stripe/webhook")
  ) {
    return true;
  }

  return false;
}

function getKey(req) {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown";

  const token = req.headers.authorization || "";

  if (!token) return ip;

  return `${ip}|${hashToken(token)}`;
}

function roleLimits(req) {
  const role = String(req.user?.role || "").toLowerCase();

  if (role === "admin") {
    return {
      maxRequests: MAX_REQUESTS_BASE * 2,
      burstLimit: BURST_LIMIT_BASE * 2
    };
  }

  if (role === "manager") {
    return {
      maxRequests: MAX_REQUESTS_BASE * 1.5,
      burstLimit: BURST_LIMIT_BASE * 1.5
    };
  }

  return {
    maxRequests: MAX_REQUESTS_BASE,
    burstLimit: BURST_LIMIT_BASE
  };
}

/* =========================================================
   CLEANUP
========================================================= */

function cleanupStore() {
  const current = now();

  for (const [key, entry] of ipStore.entries()) {
    const blockExpired =
      !entry.blockedUntil || entry.blockedUntil <= current;

    const empty =
      entry.timestamps.length === 0 &&
      entry.burst.length === 0;

    if (blockExpired && empty) {
      ipStore.delete(key);
    }
  }

  if (ipStore.size > MAX_STORE_SIZE) {
    const overflow = ipStore.size - MAX_STORE_SIZE;
    const keys = Array.from(ipStore.keys()).slice(0, overflow);
    keys.forEach(k => ipStore.delete(k));
  }
}

setInterval(cleanupStore, CLEANUP_INTERVAL);

/* ========================================================= */

function rateLimiter(req, res, next) {

  if (shouldBypass(req)) return next();

  const key = getKey(req);
  const currentTime = now();

  if (!ipStore.has(key)) {
    ipStore.set(key, {
      timestamps: [],
      burst: [],
      blockedUntil: null,
      violations: 0
    });
  }

  const entry = ipStore.get(key);

  const { maxRequests, burstLimit } = roleLimits(req);

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

  /* ================= BURST CHECK ================= */

  if (entry.burst.length > burstLimit) {
    entry.violations += 1;

    const blockTime =
      BLOCK_TIME_BASE *
      Math.pow(ESCALATION_MULTIPLIER, entry.violations - 1);

    entry.blockedUntil = currentTime + blockTime;

    writeAudit({
      actor: "traffic_shield",
      role: "system",
      action: "RATE_LIMIT_BURST_BLOCK",
      detail: {
        keyHash: hashToken(key),
        violations: entry.violations
      }
    });

    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded (burst)"
    });
  }

  /* ================= WINDOW CHECK ================= */

  if (entry.timestamps.length > maxRequests) {
    entry.violations += 1;

    const blockTime =
      BLOCK_TIME_BASE *
      Math.pow(ESCALATION_MULTIPLIER, entry.violations - 1);

    entry.blockedUntil = currentTime + blockTime;

    writeAudit({
      actor: "traffic_shield",
      role: "system",
      action: "RATE_LIMIT_WINDOW_BLOCK",
      detail: {
        keyHash: hashToken(key),
        violations: entry.violations
      }
    });

    return res.status(429).json({
      ok: false,
      error: "Rate limit exceeded"
    });
  }

  return next();
}

module.exports = rateLimiter;
