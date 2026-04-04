// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v52 (EQUITY TRACKING + MEMORY GUARD + SLIPPAGE)
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const HARD_STOP_LOSS = Number(process.env.TRADE_HARD_STOP_LOSS || -0.0045);
const SLIPPAGE_BPS = 0.0002; // 0.02% slippage for realism
const MAX_HISTORY = 500;    // Prevent memory leaks

/* ================= STATE ================= */

const STATES = new Map();

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function load(id) {
  if (!STATES.has(id)) {
    STATES.set(id, {
      cashBalance: START_BAL,
      equity: START_BAL,
      position: null,
      trades: [],
      decisions: [],
      lastPriceBySymbol: {},
      executionStats: { ticks: 0, decisions: 0, trades: 0 }
    });
  }
  return STATES.get(id);
}

/* ================= SNAPSHOT ================= */

function snapshot(id) {
  const s = load(id);
  return {
    equity: s.equity,
    cashBalance: s.cashBalance,
    position: s.position,
    trades: s.trades,
    decisions: s.decisions,
    executionStats: s.executionStats
  };
}

/* ================= CLOSE TRADE ================= */

function closeTrade({ state, symbol, price, reason }) {
  const pos = state.position;
  if (!pos) return;

  // Apply slippage to the exit price
  const effectiveExit = pos.side === "LONG" 
    ? price * (1 - SLIPPAGE_BPS) 
    : price * (1 + SLIPPAGE_BPS);

  const pnl =
    pos.side === "LONG"
      ? (effectiveExit - pos.entry) * pos.qty
      : (pos.entry - effectiveExit) * pos.qty;

  const trade = {
    side: "CLOSE",
    symbol,
    slot: pos.slot || "scalp",
    entry: pos.entry,
    exit: effectiveExit,
    qty: pos.qty,
    pnl,
    time: Date.now(),
    reason
  };

  state.cashBalance += pnl;
  state.position = null;
  state.trades.push(trade);
  
  // Memory Guard: keep history lean
  if (state.trades.length > MAX_HISTORY) state.trades.shift();
  
  state.executionStats.trades += 1;
}

/* ================= OPEN TRADE ================= */

function openTrade({ state, symbol, action, price }) {
  if (state.position) return;

  // Apply slippage to the entry price
  const effectiveEntry = action === "BUY" 
    ? price * (1 + SLIPPAGE_BPS) 
    : price * (1 - SLIPPAGE_BPS);

  const qty = (state.cashBalance * 0.01) / effectiveEntry;

  state.position = {
    symbol,
    side: action === "BUY" ? "LONG" : "SHORT",
    entry: effectiveEntry,
    qty,
    time: Date.now(),
    stopLoss:
      action === "BUY"
        ? effectiveEntry * 0.995
        : effectiveEntry * 1.005
  };
}

/* ================= TICK ================= */

function tick(id, symbol, price) {
  const state = load(id);
  const lastPrice = safeNum(state.lastPriceBySymbol[symbol], price);
  state.lastPriceBySymbol[symbol] = price;
  state.executionStats.ticks += 1;

  const pos = state.position;

  /* ================= EQUITY UPDATE ================= */
  let unrealizedPnl = 0;
  if (pos && pos.symbol === symbol) {
    unrealizedPnl = pos.side === "LONG"
      ? (price - pos.entry) * pos.qty
      : (pos.entry - price) * pos.qty;
  }
  state.equity = state.cashBalance + unrealizedPnl;

  /* ================= MANAGE OPEN ================= */
  if (pos && pos.symbol === symbol) {
    const pnlPct = unrealizedPnl / (pos.entry * pos.qty);

    if (Number.isFinite(pos.stopLoss)) {
      const stop = pos.stopLoss;
      if (
        (pos.side === "LONG" && (price <= stop || (lastPrice > stop && price < stop))) ||
        (pos.side === "SHORT" && (price >= stop || (lastPrice < stop && price > stop)))
      ) {
        return closeTrade({ state, symbol, price, reason: "STOP_LOSS" });
      }
    }

    if (pnlPct <= HARD_STOP_LOSS) {
      return closeTrade({ state, symbol, price, reason: "HARD_STOP" });
    }
  }

  /* ================= DECISION ================= */
  const plan = makeDecision({
    symbol,
    last: price,
    paper: state
  });

  state.executionStats.decisions += 1;
  state.decisions.push({ ...plan, time: Date.now() });
  
  if (state.decisions.length > MAX_HISTORY) state.decisions.shift();

  if (!state.position && (plan.action === "BUY" || plan.action === "SELL")) {
    openTrade({ state, symbol, action: plan.action, price });
  }

  if (state.position && plan.action === "CLOSE") {
    closeTrade({ state, symbol, price, reason: "AI_CLOSE" });
  }
}

module.exports = {
  tick,
  snapshot
};
