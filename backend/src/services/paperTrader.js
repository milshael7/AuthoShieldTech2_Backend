// backend/src/services/paperTrader.js
// STEP 5 — Event-Driven Paper Trader (Voice-Ready)

const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { makeDecision } = require("./tradeBrain");

/* ================= EVENT BUS ================= */

// 🔊 This is what the AI listens to
class TraderEvents extends EventEmitter {}
const traderEvents = new TraderEvents();

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE =
  process.env.PAPER_STATE_PATH || path.join("/tmp", "paper_state.json");

/* ================= HELPERS ================= */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/* ================= STATE ================= */

function defaultState() {
  return {
    running: true,

    cashBalance: START_BAL,
    equity: START_BAL,
    peakEquity: START_BAL,

    realized: { wins: 0, losses: 0, net: 0 },
    costs: { fees: 0, slippage: 0, spread: 0 },

    position: null,
    lastPriceBySymbol: {},

    brain: {
      ticks: 0,
      confidence: 0,
      decision: "WAIT",
      reason: "boot",
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      halted: false,
      haltReason: null,
      lastTradeTs: 0,
    },
  };
}

let state = defaultState();

/* ================= PERSISTENCE ================= */

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE)) };
    }
  } catch {
    state = defaultState();
  }
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

load();

/* ================= CORE ================= */

function resetDay(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}

function updateEquity(price) {
  state.equity = state.position
    ? state.cashBalance + (price - state.position.entry) * state.position.qty
    : state.cashBalance;

  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function checkDrawdown() {
  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT && !state.limits.halted) {
    state.limits.halted = true;
    state.limits.haltReason = "max_drawdown";

    traderEvents.emit("HALT", {
      reason: "Maximum drawdown reached",
      equity: state.equity,
    });
  }
}

function canTrade(ts) {
  if (state.limits.halted) return false;
  if (state.limits.tradesToday >= MAX_TRADES_DAY) return false;
  if (ts - state.limits.lastTradeTs < COOLDOWN_MS) return false;
  return true;
}

/* ================= EXECUTION ================= */

function openPosition(symbol, price, riskPct) {
  const usd = clamp(state.cashBalance * riskPct, 25, state.cashBalance - 10);
  if (usd <= 0) return;

  const fill = price * (1 + (SPREAD_BP + SLIPPAGE_BP) / 10000);
  const qty = usd / fill;
  const fee = usd * FEE_RATE;

  state.cashBalance -= usd + fee;
  state.position = { symbol, entry: fill, qty, ts: Date.now() };
  state.limits.tradesToday++;
  state.limits.lastTradeTs = Date.now();

  traderEvents.emit("ENTRY", {
    symbol,
    entry: fill,
    qty,
    confidence: state.brain.confidence,
    reason: state.brain.reason,
  });
}

function closePosition(price, reason) {
  const p = state.position;
  if (!p) return;

  const pnl = (price - p.entry) * p.qty;
  const fee = Math.abs(pnl) * FEE_RATE;

  state.cashBalance += p.qty * price - fee;
  state.realized.net += pnl - fee;
  pnl > 0 ? state.realized.wins++ : state.realized.losses++;

  traderEvents.emit("EXIT", {
    symbol: p.symbol,
    pnl: pnl - fee,
    reason,
  });

  state.position = null;
}

/* ================= TICK ================= */

function tick(symbol, price, ts = Date.now()) {
  if (!state.running) return;

  resetDay(ts);
  state.lastPriceBySymbol[symbol] = price;
  state.brain.ticks++;

  updateEquity(price);
  checkDrawdown();

  if (state.brain.ticks < WARMUP_TICKS) {
    save();
    return;
  }

  const plan = makeDecision({ symbol, last: price, paper: state });

  state.brain.confidence = plan.confidence;
  state.brain.decision = plan.action;
  state.brain.reason = plan.blockedReason || plan.action;

  if (!canTrade(ts)) {
    save();
    return;
  }

  if (plan.action === "BUY" && !state.position) {
    openPosition(symbol, price, plan.riskPct);
  }

  if ((plan.action === "SELL" || plan.action === "CLOSE") && state.position) {
    closePosition(price, plan.action.toLowerCase());
  }

  save();
}

/* ================= API ================= */

function snapshot() {
  return {
    ...state,
    unrealizedPnL: state.position
      ? (state.lastPriceBySymbol[state.position.symbol] -
          state.position.entry) *
        state.position.qty
      : 0,
  };
}

function start() {
  state.running = true;
}

function hardReset() {
  state = defaultState();
  save();
}

module.exports = {
  tick,
  snapshot,
  start,
  hardReset,
  traderEvents, // 🔑 EXPORTED FOR AI VOICE
};
