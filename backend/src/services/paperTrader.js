// backend/src/services/paperTrader.js
// Phase 18 — Unified Autonomous Paper Engine
// Explicit Mode • Risk Integrated • AI Integrated • Chart Ready

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");
const executionEngine = require("./executionEngine");
const aiBrain = require("./aiBrain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

const CANDLE_MS = 60 * 1000;
const MAX_CANDLES = 2000;

/* ================= HELPERS ================= */

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
    performance: {},
    adaptive: { riskBoost: 1 },
  };
}

const STATES = new Map();

/* ================= LOAD / SAVE ================= */

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

function save(tenantId) {
  try {
    fs.writeFileSync(
      statePath(tenantId),
      JSON.stringify(STATES.get(tenantId), null, 2)
    );
  } catch {}
}

/* ================= CANDLES ================= */

function currentCandle(state) {
  return state.candles[state.candles.length - 1];
}

function updateCandle(state, price) {
  const now = Date.now();

  if (!state.candles.length) {
    state.candles.push({
      t: now,
      o: price,
      h: price,
      l: price,
      c: price,
    });
    return;
  }

  const last = currentCandle(state);

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

  const cur = currentCandle(state);
  cur.h = Math.max(cur.h, price);
  cur.l = Math.min(cur.l, price);
  cur.c = price;
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  const prev = state.lastPrice;
  state.lastPrice = price;

  if (prev) {
    const change = Math.abs(price - prev) / prev;
    state.volatility =
      state.volatility * 0.9 + change * 0.1;
  }

  updateCandle(state, price);

  /* === Equity === */
  if (state.position) {
    state.equity =
      state.cashBalance +
      (price - state.position.entry) *
        state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }

  state.peakEquity = Math.max(
    state.peakEquity,
    state.equity
  );

  /* ================= RISK (Explicit Paper Mode) ================= */

  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    volatility: state.volatility,
    trades: state.trades,
    ts,
    mode: "paper"
  });

  /* ================= DECISION ================= */

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
    mode: "paper" // 🔥 EXPLICIT
  });

  /* ================= ENTRY ================= */

  if (plan.action === "BUY" && !state.position) {

    const portfolioCheck =
      portfolioManager.evaluate({
        tenantId,
        symbol,
        equity: state.equity,
        proposedRiskPct: plan.riskPct * risk.riskMultiplier,
        paperState: state,
      });

    if (!portfolioCheck.allow) return;

    executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: "BUY",
      price,
      riskPct: portfolioCheck.adjustedRiskPct,
      state,
      ts,
    });

    save(tenantId);
    return;
  }

  /* ================= EXIT ================= */

  if (
    (plan.action === "SELL" ||
      plan.action === "CLOSE") &&
    state.position
  ) {
    executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: "SELL",
      price,
      riskPct: 0,
      state,
      ts,
    });

    save(tenantId);
    return;
  }

  save(tenantId);
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);

  return {
    ...state,
    unrealizedPnL: state.position
      ? (state.lastPrice -
          state.position.entry) *
        state.position.qty
      : 0,
  };
}

function getCandles(tenantId, limit = 200) {
  const state = load(tenantId);
  return state.candles.slice(-limit).map(c => ({
    time: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  }));
}

function getMarketPrice(tenantId) {
  return load(tenantId).lastPrice;
}

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
  save(tenantId);
  riskManager.resetTenant?.(tenantId);
  portfolioManager.resetTenant?.(tenantId);
  aiBrain.resetBrain?.();
}

module.exports = {
  tick,
  snapshot,
  getCandles,
  getMarketPrice,
  hardReset,
};
