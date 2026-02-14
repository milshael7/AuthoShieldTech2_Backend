// backend/src/services/paperTrader.js
// Paper Trading Engine — Phase 3
// Fully Adaptive • Tenant Safe • StrategyEngine Integrated

const fs = require("fs");
const path = require("path");
const { makeDecision } = require("./tradeBrain");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200);
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);

const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `paper_${tenantId}.json`);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
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

    realized: {
      wins: 0,
      losses: 0,
      net: 0,
      grossProfit: 0,
      grossLoss: 0,
    },

    costs: {
      feePaid: 0,
    },

    position: null,
    trades: [],

    lastPrice: null,
    volatility: 0.002,

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      lastReason: "boot",
      trendEdge: 0,
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lossesToday: 0,
      halted: false,
      haltReason: null,
    },
  };
}

const STATES = new Map();

/* ================= PERSIST ================= */

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

/* ================= CORE ================= */

function updateVolatility(state, price) {
  if (!state.lastPrice) {
    state.lastPrice = price;
    return;
  }

  const change = Math.abs(price - state.lastPrice) / state.lastPrice;

  state.volatility = clamp(
    state.volatility * 0.9 + change * 0.1,
    0.0001,
    0.05
  );

  state.lastPrice = price;
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

  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = "max_drawdown";
  }
}

function resetDaily(state, ts) {
  const dk = dayKey(ts);
  if (dk !== state.limits.dayKey) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
  }
}

/* ================= EXECUTION ================= */

function openPosition(state, tenantId, symbol, price, riskPct) {
  const usd = clamp(state.cashBalance * riskPct, 50, state.cashBalance * 0.5);
  if (usd <= 0) return;

  const qty = usd / price;
  const fee = usd * FEE_RATE;

  state.cashBalance -= usd + fee;
  state.costs.feePaid += fee;

  state.position = {
    symbol,
    entry: price,
    qty,
    ts: Date.now(),
  };

  state.limits.tradesToday++;

  narrate(tenantId, `Entered ${symbol} at ${price}`, {
    action: "BUY",
  });
}

function closePosition(state, tenantId, price, reason) {
  const pos = state.position;
  if (!pos) return;

  const gross = (price - pos.entry) * pos.qty;
  const fee = Math.abs(gross) * FEE_RATE;
  const pnl = gross - fee;

  state.cashBalance += pos.qty * price - fee;
  state.costs.feePaid += fee;
  state.realized.net += pnl;

  if (pnl > 0) {
    state.realized.wins++;
    state.realized.grossProfit += pnl;
  } else {
    state.realized.losses++;
    state.realized.grossLoss += Math.abs(pnl);
    state.limits.lossesToday++;
  }

  state.trades.push({
    time: Date.now(),
    symbol: pos.symbol,
    type: "CLOSE",
    profit: pnl,
    exitReason: reason,
  });

  narrate(
    tenantId,
    `Closed ${pos.symbol}. ${pnl >= 0 ? "Profit" : "Loss"} ${pnl.toFixed(2)}`,
    { action: "CLOSE", pnl }
  );

  state.position = null;
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  resetDaily(state, ts);

  state.learnStats.ticksSeen++;
  updateVolatility(state, price);
  updateEquity(state, price);

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    save(tenantId);
    return;
  }

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.trendEdge = plan.edge;
  state.learnStats.lastReason = plan.reason || plan.blockedReason;

  if (state.limits.halted) {
    save(tenantId);
    return;
  }

  if (plan.action === "BUY" && !state.position) {
    openPosition(state, tenantId, symbol, price, plan.riskPct);
  }

  if (
    (plan.action === "SELL" || plan.action === "CLOSE") &&
    state.position
  ) {
    closePosition(state, tenantId, price, plan.reason || "signal");
  }

  save(tenantId);
}

/* ================= API ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  return {
    ...state,
    unrealizedPnL: state.position
      ? (state.lastPrice - state.position.entry) *
        state.position.qty
      : 0,
  };
}

function start() {}

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
