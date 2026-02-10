// backend/src/services/paperTrader.js
// Paper Trading Engine — TENANT SAFE (FINAL)
//
// Guarantees:
// - One isolated state per tenant
// - Deterministic execution
// - AI narration scoped by tenant
// - Safe persistence (no cross-company bleed)

const fs = require("fs");
const path = require("path");
const { makeDecision } = require("./tradeBrain");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

/* ================= HELPERS ================= */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `paper_${tenantId}.json`);
}

function narrate(tenantId, text, meta = {}) {
  if (!text) return;
  addMemory({
    tenantId,
    type: "trade_event",
    text: String(text).slice(0, 800),
    meta,
  });
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
      halted: false,
      haltReason: null,
      lastTradeTs: 0,
    },
  };
}

const STATES = new Map();

/* ================= PERSISTENCE ================= */

function load(tenantId) {
  const file = statePath(tenantId);

  if (STATES.has(tenantId)) return STATES.get(tenantId);

  let state = defaultState();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      state = { ...state, ...raw };
    }
  } catch {}

  STATES.set(tenantId, state);
  return state;
}

function save(tenantId) {
  const state = STATES.get(tenantId);
  if (!state) return;

  try {
    fs.writeFileSync(statePath(tenantId), JSON.stringify(state, null, 2));
  } catch {}
}

/* ================= CORE LOGIC ================= */

function resetDayIfNeeded(state, ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}

function updateEquity(state, price) {
  if (state.position) {
    state.equity =
      state.cashBalance +
      (price - state.position.entry) * state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }
  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function checkDrawdown(state, tenantId) {
  if (state.limits.halted) return;

  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = "max_drawdown";

    narrate(
      tenantId,
      `Trading halted. Drawdown exceeded ${(MAX_DRAWDOWN_PCT * 100).toFixed(0)}%.`,
      { equity: state.equity }
    );
  }
}

function canTrade(state, ts) {
  if (state.limits.halted) return false;
  if (state.limits.tradesToday >= MAX_TRADES_DAY) return false;
  if (ts - state.limits.lastTradeTs < COOLDOWN_MS) return false;
  return true;
}

/* ================= EXECUTION ================= */

function openPosition(state, tenantId, symbol, price, riskPct) {
  const usd = clamp(state.cashBalance * riskPct, 25, state.cashBalance - 10);
  if (usd <= 0) return;

  const spread = price * (SPREAD_BP / 10000);
  const slippage = price * (SLIPPAGE_BP / 10000);
  const fill = price + spread + slippage;

  const qty = usd / fill;
  const fee = usd * FEE_RATE;

  state.cashBalance -= usd + fee;
  state.costs.fees += fee;
  state.costs.spread += spread * qty;
  state.costs.slippage += slippage * qty;

  state.position = { symbol, entry: fill, qty, ts: Date.now() };
  state.limits.tradesToday++;
  state.limits.lastTradeTs = Date.now();

  narrate(
    tenantId,
    `Entered ${symbol} at ${fill.toFixed(2)}.`,
    { symbol, action: "BUY", entry: fill }
  );
}

function closePosition(state, tenantId, price, reason) {
  const pos = state.position;
  if (!pos) return;

  const gross = (price - pos.entry) * pos.qty;
  const fee = Math.abs(gross) * FEE_RATE;
  const pnl = gross - fee;

  state.cashBalance += pos.qty * price - fee;
  state.costs.fees += fee;
  state.realized.net += pnl;

  if (pnl > 0) state.realized.wins++;
  else state.realized.losses++;

  narrate(
    tenantId,
    `Closed ${pos.symbol}. ${pnl >= 0 ? "Profit" : "Loss"}: ${pnl.toFixed(2)}.`,
    { symbol: pos.symbol, action: "CLOSE", pnl, reason }
  );

  state.position = null;
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  resetDayIfNeeded(state, ts);
  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen++;

  updateEquity(state, price);
  checkDrawdown(state, tenantId);

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    save(tenantId);
    return;
  }

  const plan = makeDecision({
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.lastReason = plan.blockedReason || plan.action;

  if (!canTrade(state, ts)) {
    save(tenantId);
    return;
  }

  if (plan.action === "BUY" && !state.position) {
    openPosition(state, tenantId, symbol, price, plan.riskPct);
  }

  if (
    (plan.action === "SELL" || plan.action === "CLOSE") &&
    state.position &&
    state.position.symbol === symbol
  ) {
    closePosition(state, tenantId, price, plan.action);
  }

  save(tenantId);
}

/* ================= API ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
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
  // no-op (kept for compatibility)
}

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
  save(tenantId);
}

module.exports = {
  tick,
  snapshot,
  start,
  hardReset,
};
