// backend/src/lib/sessionStore.js
// Enterprise Session Control Layer — Hardened v2
// JTI Tracking • TTL Accurate • Memory Safe • Revocation Clean

const { writeAudit } = require("./audit");

/* =========================================================
   CONFIG
========================================================= */

const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/* =========================================================
   IN-MEMORY STORE
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
}

setInterval(cleanup, CLEANUP_INTERVAL);

/* =========================================================
   API
========================================================= */

function registerSession(userId, jti, ttlMs = DEFAULT_TTL) {
  if (!userId || !jti) return;

  const expiresAt = now() + ttlMs;

  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, new Map());
  }

  activeSessions.get(userId).set(jti, expiresAt);
}

function revokeToken(jti, ttlMs = DEFAULT_TTL) {
  if (!jti) return;

  const expiresAt = now() + ttlMs;
  revokedTokens.set(jti, expiresAt);

  // Remove from activeSessions
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
    revokeToken(jti);
  }

  activeSessions.delete(userId);

  writeAudit({
    actor: userId,
    role: "system",
    action: "ALL_SESSIONS_REVOKED",
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

function revokeAllSessions() {
  revokedTokens.clear();
  activeSessions.clear();

  writeAudit({
    actor: "system",
    role: "system",
    action: "GLOBAL_SESSION_RESET",
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
