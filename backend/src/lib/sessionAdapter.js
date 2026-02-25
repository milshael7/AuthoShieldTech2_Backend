// backend/src/lib/sessionAdapter.js
// Enterprise Session Adapter — Abstraction Layer v1
// Memory Store Default • Redis Ready • Swap Without Refactor

const sessionStore = require("./sessionStore");

/* =========================================================
   CONFIG
========================================================= */

const ADAPTER_MODE = process.env.SESSION_MODE || "memory";

/*
  Future modes:
  - memory (default)
  - redis
  - database
*/

/* =========================================================
   MEMORY IMPLEMENTATION
========================================================= */

const memoryAdapter = {
  registerSession(userId, jti, ttlMs) {
    return sessionStore.registerSession(userId, jti, ttlMs);
  },

  revokeToken(jti, ttlMs) {
    return sessionStore.revokeToken(jti, ttlMs);
  },

  revokeAllUserSessions(userId) {
    return sessionStore.revokeAllUserSessions(userId);
  },

  revokeAllSessions() {
    return sessionStore.revokeAllSessions();
  },

  isRevoked(jti) {
    return sessionStore.isRevoked(jti);
  },

  getActiveSessionCount(userId) {
    return sessionStore.getActiveSessionCount(userId);
  }
};

/* =========================================================
   REDIS PLACEHOLDER (FULL REPLACEMENT LATER)
========================================================= */

const redisAdapter = {
  registerSession() {
    throw new Error("Redis adapter not implemented");
  },

  revokeToken() {
    throw new Error("Redis adapter not implemented");
  },

  revokeAllUserSessions() {
    throw new Error("Redis adapter not implemented");
  },

  revokeAllSessions() {
    throw new Error("Redis adapter not implemented");
  },

  isRevoked() {
    throw new Error("Redis adapter not implemented");
  },

  getActiveSessionCount() {
    throw new Error("Redis adapter not implemented");
  }
};

/* =========================================================
   SELECT ADAPTER
========================================================= */

let adapter;

switch (ADAPTER_MODE.toLowerCase()) {
  case "redis":
    adapter = redisAdapter;
    break;

  case "memory":
  default:
    adapter = memoryAdapter;
    break;
}

/* =========================================================
   EXPORT UNIFIED API
========================================================= */

module.exports = {
  registerSession: adapter.registerSession,
  revokeToken: adapter.revokeToken,
  revokeAllUserSessions: adapter.revokeAllUserSessions,
  revokeAllSessions: adapter.revokeAllSessions,
  isRevoked: adapter.isRevoked,
  getActiveSessionCount: adapter.getActiveSessionCount
};
