// ==========================================================
// 🔒 PROTECTED CORE FILE — DO NOT MODIFY WITHOUT AUTHORIZATION
// MODULE: STATE STORE (SINGLE SOURCE OF TRUTH)
// VERSION: v1.0 (FOUNDATION LOCK)
//
// PURPOSE:
// This file is the ONLY source of truth for:
// - balances
// - positions
// - trades
// - realized PnL
//
// RULES:
// 1. DO NOT duplicate state anywhere else
// 2. DO NOT mutate state outside this module
// 3. ALL trade results MUST pass through here
// 4. UI must ONLY read from snapshots here
// 5. Any new logic MUST respect deterministic state updates
//
// WARNING:
// If this file is modified incorrectly:
// - PnL will desync
// - trades will disappear
// - system integrity is broken
//
// AUTHOR INTENT:
// This system is designed to behave like a REAL trading engine,
// not a simulation illusion. Accuracy > appearance.
//
// ==========================================================

const TENANTS = new Map();

/* ================= INIT ================= */

function createInitialState() {
  return {
    cashBalance: 10000,
    availableCapital: 10000,
    lockedCapital: 0,
    equity: 10000,

    positions: {
      scalp: null,
      structure: null,
    },

    trades: [],
    realized: {
      wins: 0,
      losses: 0,
      net: 0,
      fees: 0,
    },

    lastPriceBySymbol: {},
    lastUpdate: Date.now(),
  };
}

/* ================= GET / CREATE ================= */

function getState(tenantId) {
  const key = String(tenantId || "__default__");

  if (!TENANTS.has(key)) {
    TENANTS.set(key, createInitialState());
  }

  return TENANTS.get(key);
}

/* ================= RESET ================= */

function resetState(tenantId) {
  const key = String(tenantId || "__default__");
  const state = createInitialState();
  TENANTS.set(key, state);
  return state;
}

/* ================= UPDATE PRICE ================= */

function updatePrice(tenantId, symbol, price) {
  const state = getState(tenantId);

  state.lastPriceBySymbol[symbol] = Number(price);
  state.lastUpdate = Date.now();

  return state;
}

/* ================= SNAPSHOT ================= */

function getSnapshot(tenantId) {
  const state = getState(tenantId);

  return {
    cashBalance: state.cashBalance,
    availableCapital: state.availableCapital,
    lockedCapital: state.lockedCapital,
    equity: state.equity,
    positions: state.positions,
    trades: state.trades.slice(-100),
    realized: state.realized,
    lastPriceBySymbol: state.lastPriceBySymbol,
    lastUpdate: state.lastUpdate,
  };
}

/* ================= APPLY TRADE RESULT ================= */

function applyTradeResult(tenantId, trade) {
  const state = getState(tenantId);

  if (!trade) return;

  state.trades.push(trade);

  const pnl = Number(trade.pnl || 0);

  if (pnl > 0) state.realized.wins += 1;
  else if (pnl < 0) state.realized.losses += 1;

  state.realized.net += pnl;
}

/* ================= EXPORT ================= */

module.exports = {
  getState,
  resetState,
  updatePrice,
  getSnapshot,
  applyTradeResult,
};
