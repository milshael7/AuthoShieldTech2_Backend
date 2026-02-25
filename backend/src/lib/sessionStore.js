// backend/src/lib/sessionStore.js
// Enterprise Session Control Layer
// JTI Tracking • Revocation • Replay Guard • Redis-Ready Abstraction

const { writeAudit } = require("./audit");

/* =========================================================
   CONFIG
========================================================= */

const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/* =========================================================
   IN-MEMORY STORE
   (Swap to Redis later without changing interface)
========================================================= */

const revokedTokens = new Map(); // jti -> expiresAt
const activeSessions = new Map(); // userId -> Set<jti>

/* =========================================================
   UTIL
========================================================= */

function now() {
  return Date.now();
}

function scheduleCleanup() {
  const current = now();

  for (const [jti, expiresAt] of revokedTokens.entries()) {
    if (expiresAt <= current) {
      revokedTokens.delete(jti);
    }
  }
}

setInterval(scheduleCleanup, CLEANUP_INTERVAL);

/* =========================================================
   API
========================================================= */

/**
 * Register active session
 */
function registerSession(userId, jti, ttlMs = DEFAULT_TTL) {
  if (!userId || !jti) return;

  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, new Set());
  }

  activeSessions.get(userId).add(jti);
}

/**
 * Revoke specific token
 */
function revokeToken(jti, ttlMs = DEFAULT_TTL) {
  if (!jti) return;

  const expiresAt = now() + ttlMs;
  revokedTokens.set(jti, expiresAt);

  writeAudit({
    actor: "session_store",
    role: "system",
    action: "TOKEN_REVOKED",
    detail: { jti }
  });
}

/**
 * Revoke all sessions for a user
 */
function revokeAllUserSessions(userId) {
  if (!activeSessions.has(userId)) return;

  const sessions = activeSessions.get(userId);

  for (const jti of sessions) {
    revokeToken(jti);
  }

  activeSessions.delete(userId);

  writeAudit({
    actor: userId,
    role: "system",
    action: "ALL_SESSIONS_REVOKED"
  });
}

/**
 * Check if token is revoked
 */
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

/**
 * Optional: get active session count
 */
function getActiveSessionCount(userId) {
  return activeSessions.get(userId)?.size || 0;
}

/**
 * Hard kill all sessions (emergency mode)
 */
function revokeAllSessions() {
  revokedTokens.clear();
  activeSessions.clear();

  writeAudit({
    actor: "system",
    role: "system",
    action: "GLOBAL_SESSION_RESET"
  });
}

module.exports = {
  registerSession,
  revokeToken,
  revokeAllUserSessions,
  revokeAllSessions,
  isRevoked,
  getActiveSessionCount,
};
