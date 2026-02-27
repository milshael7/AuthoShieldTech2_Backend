// backend/src/lib/sessionStore.js
// AutoShield Tech — Enterprise Session Control v3
// Replay Guard • Session Cap • Memory Bounded • TTL Safe • Crash Hardened

const { writeAudit } = require("./audit");

/* =========================================================
   CONFIG
========================================================= */

const CLEANUP_INTERVAL = 60 * 1000;           // 1 minute
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days

const MAX_SESSIONS_PER_USER = 25;             // 🔒 per-user cap
const MAX_TOTAL_SESSIONS = 50000;             // 🔒 global cap
const MAX_REVOKED_TOKENS = 100000;            // 🔒 memory bound

/* =========================================================
   STORE
========================================================= */

// jti -> expiresAt
const revokedTokens = new Map();

// userId -> Map<jti, expiresAt>
const activeSessions = new Map();

/* =========================================================
   UTIL
========================================================= */

function now() {
  return Date.now();
}

function normalizeTTL(ttlMs) {
  if (!ttlMs || typeof ttlMs !== "number") {
    return DEFAULT_TTL;
  }
  return Math.max(1000, ttlMs);
}

function totalSessionCount() {
  let count = 0;
  for (const sessions of activeSessions.values()) {
    count += sessions.size;
  }
  return count;
}

/* =========================================================
   CLEANUP LOOP
========================================================= */

function cleanup() {
  const current = now();

  // Clean revoked tokens
  for (const [jti, expiresAt] of revokedTokens.entries()) {
    if (expiresAt <= current) {
      revokedTokens.delete(jti);
    }
  }

  // Clean expired active sessions
  for (const [userId, sessions] of activeSessions.entries()) {
    for (const [jti, expiresAt] of sessions.entries()) {
      if (expiresAt <= current) {
        sessions.delete(jti);
      }
    }

    if (sessions.size === 0) {
      activeSessions.delete(userId);
    }
  }

  // Enforce revoked token bound
  if (revokedTokens.size > MAX_REVOKED_TOKENS) {
    const excess = revokedTokens.size - MAX_REVOKED_TOKENS;
    const keys = Array.from(revokedTokens.keys()).slice(0, excess);
    for (const key of keys) revokedTokens.delete(key);
  }
}

const interval = setInterval(cleanup, CLEANUP_INTERVAL);
interval.unref(); // 🔒 does not block process shutdown

/* =========================================================
   API
========================================================= */

function registerSession(userId, jti, ttlMs = DEFAULT_TTL) {
  if (!userId || !jti) return;

  ttlMs = normalizeTTL(ttlMs);

  const expiresAt = now() + ttlMs;

  // Replay guard — if already revoked, block
  if (revokedTokens.has(jti)) {
    return;
  }

  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, new Map());
  }

  const sessions = activeSessions.get(userId);

  // Enforce per-user cap
  if (sessions.size >= MAX_SESSIONS_PER_USER) {
    const oldestJti = sessions.keys().next().value;
    revokeToken(oldestJti);
  }

  sessions.set(jti, expiresAt);

  // Enforce global cap
  if (totalSessionCount() > MAX_TOTAL_SESSIONS) {
    revokeAllSessions();
  }
}

function revokeToken(jti, ttlMs = DEFAULT_TTL) {
  if (!jti) return;

  ttlMs = normalizeTTL(ttlMs);

  const expiresAt = now() + ttlMs;
  revokedTokens.set(jti, expiresAt);

  // Remove from active sessions
  for (const sessions of activeSessions.values()) {
    sessions.delete(jti);
  }

  writeAudit({
    actor: "session_store",
    role: "system",
    action: "TOKEN_REVOKED",
    detail: { jti },
  });
}

function revokeAllUserSessions(userId) {
  if (!activeSessions.has(userId)) return;

  const sessions = activeSessions.get(userId);

  for (const jti of sessions.keys()) {
    revokedTokens.set(jti, now() + DEFAULT_TTL);
  }

  activeSessions.delete(userId);

  writeAudit({
    actor: userId,
    role: "system",
    action: "ALL_SESSIONS_REVOKED",
  });
}

function revokeAllSessions() {
  revokedTokens.clear();
  activeSessions.clear();

  writeAudit({
    actor: "system",
    role: "system",
    action: "GLOBAL_SESSION_RESET",
  });
}

function isRevoked(jti) {
  if (!jti) return true;

  const expiresAt = revokedTokens.get(jti);
  if (!expiresAt) return false;

  if (expiresAt <= now()) {
    revokedTokens.delete(jti);
    return false;
  }

  return true;
}

function getActiveSessionCount(userId) {
  return activeSessions.get(userId)?.size || 0;
}

module.exports = {
  registerSession,
  revokeToken,
  revokeAllUserSessions,
  revokeAllSessions,
  isRevoked,
  getActiveSessionCount,
};
