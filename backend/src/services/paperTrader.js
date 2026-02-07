// backend/src/services/paperTrader.js
// Paper trading engine — SAFE, deterministic, AI-aware
// STEP 6: Voice-aware + event-driven (NO external wiring required)

const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { makeDecision } = require("./tradeBrain");

/* ================= EVENT BUS ================= */

const traderEvents = new EventEmitter();

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const BASELINE_PCT = Number(process.env.PAPER_BASELINE_PCT || 0.03);
const MAX_PCT = Number(process.env.PAPER_OWNER_MAX_PCT || 0.5);
const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE =
  process.env.PAPER_STATE_PATH || path.join("/tmp", "paper_state.json");

/* ================= HELPERS ================= */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

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
    trades: [],
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      lastReason: "boot",
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lastTradeTs: 0,
      halted: false,
      haltReason: null,
    },

    config: {
      baselinePct: BASELINE_PCT,
      maxPct: MAX_PCT,
    },
  };
}

let state = defaultState();

/* ================= PERSIST ================= */

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

function resetDayIfNeeded(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}

function updateEquity(price) {
  if (state.position) {
    state.equity =
      state.cashBalance +
      (price - state.position.entry) * state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }
  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function checkDrawdown() {
  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = "Maximum drawdown reached";

    traderEvents.emit("HALT", {
      reason: state.limits.haltReason,
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

function openPosition(symbol, price, riskPct, reason, confidence) {
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
    price: fill,
    confidence,
    reason,
  });
}

function closePosition(price, reason) {
  const pos = state.position;
  if (!pos) return;

  const gross = (price - pos.entry) * pos.qty;
  const fee = Math.abs(gross) * FEE_RATE;

  state.cashBalance += pos.qty * price - fee;
  state.realized.net += gross - fee;
  state.realized[gross > 0 ? "wins" : "losses"]++;

  traderEvents.emit("EXIT", {
    symbol: pos.symbol,
    pnl: gross - fee,
    reason,
  });

  state.position = null;
}

/* ================= TICK ================= */

function tick(symbol, price, ts = Date.now()) {
  if (!state.running) return;

  resetDayIfNeeded(ts);
  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen++;

  updateEquity(price);
  checkDrawdown();

  if (state.learnStats.ticksSeen < WARMUP_TICKS) return;

  const plan = makeDecision({
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.confidence = plan.confidence;
  state.learnStats.decision = plan.action;
  state.learnStats.lastReason = plan.reason || plan.action;

  if (!canTrade(ts)) return;

  if (plan.action === "BUY" && !state.position) {
    openPosition(
      symbol,
      price,
      plan.riskPct,
      plan.reason,
      plan.confidence
    );
  }

  if (plan.action === "CLOSE" && state.position) {
    closePosition(price, plan.reason);
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
  start,
  tick,
  snapshot,
  hardReset,
  traderEvents, // 🔑 exported for AI / UI / Voice
};
