// backend/src/lib/sessionAdapter.js
// AutoShield Tech — Enterprise Session Adapter v2
// Mode Safe • Validation Hardened • Crash Isolated • Replay Ready

const sessionStore = require("./sessionStore");

/* =========================================================
   CONFIG
========================================================= */

const ADAPTER_MODE = (process.env.SESSION_MODE || "memory").toLowerCase();

/*
  Supported:
  - memory
  - redis (future)
*/

/* =========================================================
   INPUT GUARDS
========================================================= */

function assertString(v, name) {
  if (!v || typeof v !== "string") {
    throw new Error(`Invalid ${name}`);
  }
}

function normalizeTTL(ttlMs) {
  if (!ttlMs || typeof ttlMs !== "number") {
    return 15 * 60 * 1000; // default 15m
  }
  return Math.max(1000, ttlMs);
}

/* =========================================================
   MEMORY ADAPTER
========================================================= */

const memoryAdapter = {
  registerSession(userId, jti, ttlMs) {
    assertString(userId, "userId");
    assertString(jti, "jti");
    return sessionStore.registerSession(
      userId,
      jti,
      normalizeTTL(ttlMs)
    );
  },

  revokeToken(jti, ttlMs) {
    assertString(jti, "jti");
    return sessionStore.revokeToken(
      jti,
      normalizeTTL(ttlMs)
    );
  },

  revokeAllUserSessions(userId) {
    assertString(userId, "userId");
    return sessionStore.revokeAllUserSessions(userId);
  },

  revokeAllSessions() {
    return sessionStore.revokeAllSessions();
  },

  isRevoked(jti) {
    if (!jti || typeof jti !== "string") return true;
    return sessionStore.isRevoked(jti);
  },

  getActiveSessionCount(userId) {
    if (!userId || typeof userId !== "string") return 0;
    return sessionStore.getActiveSessionCount(userId);
  }
};

/* =========================================================
   REDIS PLACEHOLDER
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
   SELECT ADAPTER (STRICT)
========================================================= */

let adapter;

switch (ADAPTER_MODE) {
  case "memory":
    adapter = memoryAdapter;
    break;

  case "redis":
    console.warn("[SESSION] Redis mode selected but not implemented.");
    adapter = redisAdapter;
    break;

  default:
    throw new Error(
      `Invalid SESSION_MODE: ${ADAPTER_MODE}`
    );
}

/* =========================================================
   SAFE WRAPPERS
   Prevent session layer from crashing core server
========================================================= */

function safe(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error("[SESSION ERROR]", err.message);
      return null;
    }
  };
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  registerSession: safe(adapter.registerSession),
  revokeToken: safe(adapter.revokeToken),
  revokeAllUserSessions: safe(adapter.revokeAllUserSessions),
  revokeAllSessions: safe(adapter.revokeAllSessions),
  isRevoked: safe(adapter.isRevoked),
  getActiveSessionCount: safe(adapter.getActiveSessionCount),
};
