// ==========================================================
// 🔒 STATE STORE — v1.1 (DYNAMIC EQUITY & FOUNDATION LOCK)
// FILE: backend/src/engine/stateStore.js
// ==========================================================

const TENANTS = new Map();

/* ================= INIT ================= */

function createInitialState() {
  return {
    cashBalance: 10000,      // Realized cash
    availableCapital: 10000, // Cash not tied up in margin
    lockedCapital: 0,        // Capital currently in active trades
    equity: 10000,           // Cash + Unrealized PnL

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

/* ================= DYNAMIC EQUITY CALC ================= */

/**
 * Updates equity based on last known prices for open positions.
 * This is the "Heartbeat" that makes the dashboard needle move.
 */
function refreshEquity(state) {
  let unrealized = 0;

  Object.values(state.positions).forEach(pos => {
    if (!pos) return;
    const currentPrice = state.lastPriceBySymbol[pos.symbol];
    if (!currentPrice) return;

    const diff = pos.side === "LONG" 
      ? (currentPrice - pos.entry) 
      : (pos.entry - currentPrice);
    
    unrealized += (diff * pos.qty);
  });

  state.equity = state.cashBalance + unrealized;
}

/* ================= UPDATE PRICE ================= */

function updatePrice(tenantId, symbol, price) {
  const state = getState(tenantId);
  state.lastPriceBySymbol[symbol] = Number(price);
  
  // 🛰️ PUSH 5.5: Real-time equity recalculation on every price tick
  refreshEquity(state);
  
  state.lastUpdate = Date.now();
  return state;
}

/* ================= APPLY TRADE RESULT ================= */

function applyTradeResult(tenantId, trade) {
  const state = getState(tenantId);
  if (!trade) return;

  // 1. Record the trade
  state.trades.push(trade);
  if (state.trades.length > 200) state.trades.shift();

  // 2. Update realized metrics
  const pnl = Number(trade.pnl || 0);
  const fees = Number(trade.fees || 0);

  if (pnl > 0) state.realized.wins += 1;
  else if (pnl < 0) state.realized.losses += 1;

  state.realized.net += pnl;
  state.realized.fees += fees;

  // 3. Update Balance (Settlement)
  state.cashBalance += pnl;
  
  // 4. Reset Equity to Cash (as no positions are open in this slot)
  refreshEquity(state);
}

/* ================= SNAPSHOT ================= */

function getSnapshot(tenantId) {
  const state = getState(tenantId);
  return {
    ...state,
    trades: state.trades.slice(-50), // Optimization for socket payload
  };
}

function resetState(tenantId) {
  const key = String(tenantId || "__default__");
  const state = createInitialState();
  TENANTS.set(key, state);
  return state;
}

module.exports = {
  getState,
  resetState,
  updatePrice,
  getSnapshot,
  applyTradeResult,
};
