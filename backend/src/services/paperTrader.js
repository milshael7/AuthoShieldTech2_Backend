// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v51 (FIXED STOP LOSS + REAL TRADE TRACKING)
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const HARD_STOP_LOSS = Number(process.env.TRADE_HARD_STOP_LOSS || -0.0045);

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
    trades: s.trades.slice(-500),
    decisions: s.decisions.slice(-200),
    executionStats: s.executionStats
  };
}

/* ================= CLOSE TRADE ================= */

function closeTrade({ state, symbol, price, reason }) {
  const pos = state.position;
  if (!pos) return;

  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) * pos.qty
      : (pos.entry - price) * pos.qty;

  const trade = {
    side: "CLOSE", // ✅ CRITICAL FIX
    symbol,
    slot: pos.slot || "scalp",
    entry: pos.entry,
    exit: price,
    qty: pos.qty,
    pnl,
    time: Date.now(),
    reason
  };

  state.cashBalance += pnl;
  state.position = null;
  state.trades.push(trade);
  state.executionStats.trades += 1;
}

/* ================= OPEN TRADE ================= */

function openTrade({ state, symbol, action, price }) {
  if (state.position) return;

  const qty = (state.cashBalance * 0.01) / price;

  state.position = {
    symbol,
    side: action === "BUY" ? "LONG" : "SHORT",
    entry: price,
    qty,
    time: Date.now(),
    stopLoss:
      action === "BUY"
        ? price * 0.995
        : price * 1.005
  };
}

/* ================= TICK ================= */

function tick(id, symbol, price) {
  const state = load(id);

  const lastPrice = safeNum(state.lastPriceBySymbol[symbol], price);
  state.lastPriceBySymbol[symbol] = price;

  state.executionStats.ticks += 1;

  const pos = state.position;

  /* ================= MANAGE OPEN ================= */

  if (pos && pos.symbol === symbol) {
    const pnlPct =
      pos.side === "LONG"
        ? (price - pos.entry) / pos.entry
        : (pos.entry - price) / pos.entry;

    /* 🔥 GAP SAFE STOP LOSS FIX */
    if (Number.isFinite(pos.stopLoss)) {
      const stop = pos.stopLoss;

      if (
        pos.side === "LONG" &&
        (price <= stop || (lastPrice > stop && price < stop))
      ) {
        return closeTrade({ state, symbol, price, reason: "STOP_LOSS" });
      }

      if (
        pos.side === "SHORT" &&
        (price >= stop || (lastPrice < stop && price > stop))
      ) {
        return closeTrade({ state, symbol, price, reason: "STOP_LOSS" });
      }
    }

    /* HARD STOP */
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

  state.decisions.push({
    ...plan,
    time: Date.now()
  });

  if (!state.position && (plan.action === "BUY" || plan.action === "SELL")) {
    openTrade({
      state,
      symbol,
      action: plan.action,
      price
    });
  }

  if (state.position && plan.action === "CLOSE") {
    closeTrade({ state, symbol, price, reason: "AI_CLOSE" });
  }
}

/* ================= EXPORTS ================= */

module.exports = {
  tick,
  snapshot
};
