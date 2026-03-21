// ==========================================================
// 🔒 PROTECTED CORE FILE — DO NOT MODIFY WITHOUT AUTHORIZATION
// MODULE: ENGINE CONFIG (CONTROL LAYER)
// VERSION: v1.0 (SYSTEM CONFIGURATION)
//
// PURPOSE:
// Central configuration for trading behavior
//
// RULES:
// 1. ALL tunable values MUST live here
// 2. NO hardcoding values in other engine files
// 3. Changes here affect entire system behavior
//
// ==========================================================

/* ================= TRADE SETTINGS ================= */

const TRADE_CONFIG = {
  DEFAULT_QTY: 0.01,          // base position size

  STOP_LOSS_PCT: 0.005,       // 0.5%
  TAKE_PROFIT_PCT: 0.005,     // 0.5%

  MAX_OPEN_POSITIONS: 1,      // single trade system
};

/* ================= RISK SETTINGS ================= */

const RISK_CONFIG = {
  DEFAULT_RISK_PCT: 0.01,     // 1% risk per trade
  MAX_RISK_PCT: 0.03,         // 3% max risk
  MIN_RISK_PCT: 0.001,        // 0.1% minimum risk
};

/* ================= ENGINE TIMING ================= */

const ENGINE_CONFIG = {
  ENGINE_TICK_MS: 1500,       // AI decision speed
  MARKET_TICK_MS: 1000,       // market update speed
};

/* ================= LIMITS ================= */

const LIMITS_CONFIG = {
  MAX_TRADES_PER_DAY: 100,
  MAX_LOSSES_PER_DAY: 50,
};

/* ================= STORAGE ================= */

const STORAGE_CONFIG = {
  MAX_DECISIONS: 200,
  MAX_TRADES: 500,
};

/* ================= EXPORT ================= */

module.exports = {
  TRADE_CONFIG,
  RISK_CONFIG,
  ENGINE_CONFIG,
  LIMITS_CONFIG,
  STORAGE_CONFIG,
};
