// ==========================================================
// ⚙️ ENGINE CONFIG — v1.1 (UNISON UNIFIED)
// FILE: backend/src/engine/config.js
// ==========================================================

/* ================= TRADE SETTINGS ================= */
const TRADE_CONFIG = {
  DEFAULT_QTY: 0.01,          // Base position size
  STOP_LOSS_PCT: 0.005,       // 0.5% (Hard-coded safety)
  TAKE_PROFIT_PCT: 0.005,     // 0.5% (Target)
  MAX_OPEN_POSITIONS: 1,      // Single trade focus for learning phase
};

/* ================= RISK SETTINGS ================= */
const RISK_CONFIG = {
  DEFAULT_RISK_PCT: 0.01,     // 1% risk per trade
  MAX_RISK_PCT: 0.03,         // 3% max risk cap
  MIN_RISK_PCT: 0.001,        // 0.1% minimum risk floor
};

/* ================= ENGINE TIMING ================= */
const ENGINE_CONFIG = {
  ENGINE_TICK_MS: 1500,       // AI decision interval
  MARKET_TICK_MS: 1000,       // Market data pump speed
};

/* ================= LIMITS ================= */
const LIMITS_CONFIG = {
  MAX_TRADES_PER_DAY: 100,
  MAX_LOSSES_PER_DAY: 50,     // Daily circuit breaker
};

/* ================= STORAGE ================= */
const STORAGE_CONFIG = {
  MAX_DECISIONS: 200,         // Depth of UI history
  MAX_TRADES: 500,            // Depth of PnL history
};

/* ================= EXPORT ================= */
module.exports = {
  TRADE_CONFIG,
  RISK_CONFIG,
  ENGINE_CONFIG,
  LIMITS_CONFIG,
  STORAGE_CONFIG,
  // 🛰️ PUSH 6.5: Helper to grab all for dynamic service loading
  all: { ...TRADE_CONFIG, ...RISK_CONFIG, ...ENGINE_CONFIG, ...LIMITS_CONFIG, ...STORAGE_CONFIG }
};
