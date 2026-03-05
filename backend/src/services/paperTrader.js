// backend/src/services/paperTrader.js
// ==========================================================
// Autonomous Paper Trading Engine — STABLE CORE
// Non-blocking • Reentrant-safe • Snapshot-safe
// ==========================================================

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");
const executionEngine = require("./executionEngine");
const aiBrain = require("./aiBrain");

const orderFlowEngine = require("./orderFlowEngine");
const counterfactualEngine = require("./counterfactualEngine");
const correlationEngine = require("./correlationEngine");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const BASE_PATH =
  process.env.PAPER_STATE_DIR ||
  path.join("/tmp", "paper_trader");

const CANDLE_MS = 60000;
const MAX_CANDLES = 2000;
const MAX_TRADES_MEMORY = 500;
const SAVE_INTERVAL_MS = 5000;

/* ================= FS HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `paper_${tenantId}.json`);
}

/* ================= STATE ================= */

function defaultState() {
  return {
    running: true,

    cashBalance: START_BAL,
    equity: START_BAL,
    peakEquity: START_BAL,

    position: null,
    trades: [],

    volatility: 0.002,
    lastPrice: 65000,

    candles: [],

    learnStats: {
      trendEdge: 0,
      confidence: 0,
    },

    adaptive: { riskBoost: 1 },

    _dirty: false,
    _lastSave: 0,
    _locked: false,
  };
}

const STATES = new Map();

/* ================= LOAD ================= */

function load(tenantId) {
  if (STATES.has(tenantId)) return STATES.get(tenantId);

  let state = defaultState();
  const file = statePath(tenantId);

  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      state = { ...state, ...raw };
    }
  } catch {}

  STATES.set(tenantId, state);
  return state;
}

/* ================= ASYNC SAVE ================= */

function scheduleSave(tenantId, state) {
  const now = Date.now();
  if (!state._dirty) return;
  if (now - state._lastSave < SAVE_INTERVAL_MS) return;

  state._dirty = false;
  state._lastSave = now;

  const file = statePath(tenantId);
  const snapshot = JSON.stringify(
    { ...state, _dirty: undefined, _locked: undefined },
    null,
    2
  );

  setImmediate(() => {
    try {
      fs.writeFileSync(file, snapshot);
    } catch {}
  });
}

/* ================= CANDLES ================= */

function updateCandle(state, price) {
  const now = Date.now();

  if (!state.candles.length) {
    state.candles.push({ t: now, o: price, h: price, l: price, c: price });
    return;
  }

  const last = state.candles[state.candles.length - 1];

  if (now - last.t >= CANDLE_MS) {
    state.candles.push({
      t: now,
      o: last.c,
      h: last.c,
      l: last.c,
      c: last.c,
    });

    if (state.candles.length > MAX_CANDLES) {
      state.candles = state.candles.slice(-MAX_CANDLES);
    }
  }

  const cur = state.candles[state.candles.length - 1];
  cur.h = Math.max(cur.h, price);
  cur.l = Math.min(cur.l, price);
  cur.c = price;
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);

  if (!state.running || state._locked) return;
  state._locked = true;

  try {
    orderFlowEngine.recordPrice({ tenantId, price });
    counterfactualEngine.recordPrice({ tenantId, price });
    correlationEngine.recordPrice({ tenantId, symbol, price });

    const prev = state.lastPrice;
    state.lastPrice = price;

    if (prev) {
      const change = Math.abs(price - prev) / prev;
      state.volatility = state.volatility * 0.9 + change * 0.1;
    }

    updateCandle(state, price);

    if (state.position) {
      state.equity =
        state.cashBalance +
        (price - state.position.entry) * state.position.qty;
    } else {
      state.equity = state.cashBalance;
    }

    state.peakEquity = Math.max(state.peakEquity, state.equity);

    const risk = riskManager.evaluate({
      tenantId,
      equity: state.equity,
      volatility: state.volatility,
      trades: state.trades,
      ts,
      mode: "paper",
    });

    const plan = makeDecision({
      tenantId,
      symbol,
      last: price,
      paper: state,
      mode: "paper",
    });

    if (plan.action === "BUY" && !state.position) {
      const portfolioCheck = portfolioManager.evaluate({
        tenantId,
        symbol,
        equity: state.equity,
        proposedRiskPct: plan.riskPct * risk.riskMultiplier,
        paperState: state,
      });

      if (portfolioCheck.allow) {
        executionEngine.executePaperOrder({
          tenantId,
          symbol,
          action: "BUY",
          price,
          riskPct: portfolioCheck.adjustedRiskPct,
          state,
          ts,
        });

        state._dirty = true;
      }
    }

    if (
      (plan.action === "SELL" || plan.action === "CLOSE") &&
      state.position
    ) {
      const result = executionEngine.executePaperOrder({
        tenantId,
        symbol,
        action: "SELL",
        price,
        riskPct: 0,
        state,
        ts,
      });

      if (result?.result?.pnl !== undefined) {
        aiBrain.recordTradeOutcome({
          tenantId,
          pnl: result.result.pnl,
        });
      }

      state.trades = state.trades.slice(-MAX_TRADES_MEMORY);
      state._dirty = true;
    }

    scheduleSave(tenantId, state);

  } finally {
    state._locked = false;
  }
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const s = load(tenantId);

  return JSON.parse(
    JSON.stringify({
      cashBalance: s.cashBalance,
      equity: s.equity,
      peakEquity: s.peakEquity,
      position: s.position,
      trades: s.trades,
      lastPrice: s.lastPrice,
      volatility: s.volatility,
      unrealizedPnL: s.position
        ? (s.lastPrice - s.position.entry) * s.position.qty
        : 0,
      limits: {},
    })
  );
}

/* ================= EXPORTS ================= */

module.exports = {
  tick,
  snapshot,
  getCandles: (tenantId, limit = 200) =>
    load(tenantId).candles.slice(-limit).map(c => ({
      time: Math.floor(c.t / 1000), // CHART FIX
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    })),
  getMarketPrice: tenantId => load(tenantId).lastPrice,
  hardReset: tenantId => STATES.set(tenantId, defaultState()),
};
