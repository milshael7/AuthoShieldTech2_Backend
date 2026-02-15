// backend/src/services/paperTrader.js
// Phase 14 — Fully Reinforced Autonomous Paper Engine
// Unlimited Learning Mode
// AI Reinforcement Integrated
// Expectancy + Adaptive Aggression
// Friday Shutdown
// Production Safe • Institutional Grade

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");
const executionEngine = require("./executionEngine");
const aiBrain = require("./aiBrain");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200);
const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

const PERFORMANCE_WINDOW = 50;

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

function isFridayShutdown(ts) {
  const d = new Date(ts);
  return d.getUTCDay() === 5 && d.getUTCHours() >= 20;
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

    performance: {
      window: [],
      winRate: 0,
      expectancy: 0,
      avgWin: 0,
      avgLoss: 0,
    },

    position: null,
    trades: [],

    lastPrice: null,
    volatility: 0.002,

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      trendEdge: 0,
      lastReason: "boot",
    },

    adaptive: {
      winStreak: 0,
      lossStreak: 0,
      riskBoost: 1,
    },
  };
}

const STATES = new Map();

/* ================= PERSIST ================= */

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
  const state = STATES.get(tenantId);
  if (!state) return;

  try {
    fs.writeFileSync(
      statePath(tenantId),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

/* ================= PERFORMANCE ================= */

function updatePerformance(state, trade) {
  state.performance.window.push(trade.profit);

  if (state.performance.window.length > PERFORMANCE_WINDOW)
    state.performance.window =
      state.performance.window.slice(-PERFORMANCE_WINDOW);

  const wins = state.performance.window.filter(p => p > 0);
  const losses = state.performance.window.filter(p => p <= 0);

  state.performance.winRate =
    wins.length / state.performance.window.length;

  state.performance.avgWin =
    wins.length > 0
      ? wins.reduce((a, b) => a + b, 0) / wins.length
      : 0;

  state.performance.avgLoss =
    losses.length > 0
      ? losses.reduce((a, b) => a + b, 0) / losses.length
      : 0;

  state.performance.expectancy =
    state.performance.winRate *
      state.performance.avgWin +
    (1 - state.performance.winRate) *
      state.performance.avgLoss;
}

/* ================= ADAPTIVE ================= */

function updateAdaptive(state, trade) {
  if (trade.profit > 0) {
    state.adaptive.winStreak++;
    state.adaptive.lossStreak = 0;
    state.adaptive.riskBoost =
      clamp(state.adaptive.riskBoost * 1.1, 1, 2);
  } else {
    state.adaptive.lossStreak++;
    state.adaptive.winStreak = 0;
    state.adaptive.riskBoost =
      clamp(state.adaptive.riskBoost * 0.7, 0.4, 1);
  }
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  if (isFridayShutdown(ts)) return;

  /* --- Update price first --- */
  const prevPrice = state.lastPrice;
  state.lastPrice = price;
  state.learnStats.ticksSeen++;

  /* --- Volatility --- */
  if (prevPrice) {
    const change = Math.abs(price - prevPrice) / prevPrice;
    state.volatility =
      state.volatility * 0.9 + change * 0.1;
  }

  /* --- Equity --- */
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

  /* --- Risk Layer (Paper Mode Still Evaluated) --- */
  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    volatility: state.volatility,
    trades: state.trades,
    ts,
  });

  if (state.learnStats.ticksSeen < WARMUP_TICKS)
    return;

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.trendEdge = plan.edge;

  /* ================= EXIT ================= */

  if (
    (plan.action === "SELL" ||
      plan.action === "CLOSE") &&
    state.position
  ) {
    const result =
      executionEngine.executePaperOrder({
        tenantId,
        symbol,
        action: plan.action,
        price,
        riskPct: 0,
        state,
        ts,
      });

    if (result?.result?.type === "EXIT") {
      const trade = result.result;

      updatePerformance(state, trade);
      updateAdaptive(state, trade);

      // 🔥 Reinforcement loop into AI
      aiBrain.recordTradeOutcome({
        pnl: trade.pnl,
      });
    }

    save(tenantId);
    return;
  }

  /* ================= ENTRY ================= */

  if (plan.action !== "BUY" || state.position)
    return;

  const portfolioCheck =
    portfolioManager.evaluate({
      tenantId,
      symbol,
      equity: state.equity,
      proposedRiskPct: plan.riskPct,
      paperState: state,
    });

  if (!portfolioCheck.allow) return;

  let adjustedRisk =
    portfolioCheck.adjustedRiskPct *
    (risk.riskMultiplier || 1);

  adjustedRisk *= state.adaptive.riskBoost;
  adjustedRisk = clamp(adjustedRisk, 0.001, 0.08);

  executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action: "BUY",
    price,
    riskPct: adjustedRisk,
    state,
    ts,
  });

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

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
  save(tenantId);
  riskManager.resetTenant(tenantId);
  portfolioManager.resetTenant(tenantId);
  aiBrain.resetBrain();
}

module.exports = {
  tick,
  snapshot,
  hardReset,
};
