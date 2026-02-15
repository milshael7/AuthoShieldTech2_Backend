// backend/src/services/paperTrader.js
// Phase 12 — Adaptive Self-Learning Paper Engine
// Aggressive + Controlled + Friday Shutdown
// Reinforcement Layer Added
// Fully Tenant Safe • No Breaking Changes

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");
const executionEngine = require("./executionEngine");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200);

const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

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

function isFridayShutdown(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 5 = Friday
  const hour = d.getUTCHours();
  return day === 5 && hour >= 20; // 20:00 UTC Friday stop
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

    adaptive: {
      winStreak: 0,
      lossStreak: 0,
      riskBoost: 1,
      aggressionMode: false,
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lossesToday: 0,
      halted: false,
      haltReason: null,
      cooling: false,
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

/* ================= CORE ================= */

function updateVolatility(state, price) {
  if (!state.lastPrice) {
    state.lastPrice = price;
    return;
  }

  const change =
    Math.abs(price - state.lastPrice) /
    state.lastPrice;

  state.volatility = clamp(
    state.volatility * 0.9 + change * 0.1,
    0.0001,
    0.05
  );

  state.lastPrice = price;
}

function updateEquity(state) {
  if (state.position && state.lastPrice) {
    state.equity =
      state.cashBalance +
      (state.lastPrice - state.position.entry) *
        state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }

  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function resetDaily(state, ts) {
  const dk = dayKey(ts);
  if (dk !== state.limits.dayKey) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;

    state.adaptive.winStreak = 0;
    state.adaptive.lossStreak = 0;
    state.adaptive.riskBoost = 1;
    state.adaptive.aggressionMode = false;
  }
}

/* ================= ADAPTIVE LEARNING ================= */

function updateAdaptiveAfterTrade(state, tradeResult) {
  if (!tradeResult) return;

  if (tradeResult.isWin) {
    state.adaptive.winStreak++;
    state.adaptive.lossStreak = 0;

    if (state.adaptive.winStreak >= 2) {
      state.adaptive.aggressionMode = true;
      state.adaptive.riskBoost = clamp(
        state.adaptive.riskBoost * 1.2,
        1,
        1.8
      );
    }
  } else {
    state.adaptive.lossStreak++;
    state.adaptive.winStreak = 0;

    state.adaptive.riskBoost = clamp(
      state.adaptive.riskBoost * 0.6,
      0.4,
      1
    );

    state.adaptive.aggressionMode = false;

    if (state.adaptive.lossStreak >= 2) {
      state.limits.cooling = true;
    }
  }
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  if (isFridayShutdown(ts)) {
    state.limits.halted = true;
    state.limits.haltReason = "Friday shutdown";
    save(tenantId);
    return;
  }

  state.lastPrice = price;

  resetDaily(state, ts);

  state.learnStats.ticksSeen++;
  updateVolatility(state, price);
  updateEquity(state);

  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    realizedNet: state.realized.net,
    volatility: state.volatility,
    trades: state.trades,
    limits: state.limits,
    ts,
  });

  state.limits.halted = risk.halted;
  state.limits.haltReason = risk.haltReason || null;
  state.limits.cooling = risk.cooling;

  if (risk.halted || risk.cooling) {
    save(tenantId);
    return;
  }

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
  state.learnStats.lastReason = plan.reason;

  /* ===== EXIT ===== */

  if (
    (plan.action === "SELL" || plan.action === "CLOSE") &&
    state.position
  ) {
    const result = executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: plan.action,
      price,
      riskPct: 0,
      state,
      ts,
    });

    if (result?.narration) {
      narrate(
        tenantId,
        result.narration.text,
        result.narration.meta
      );
    }

    if (result?.result?.type === "EXIT") {
      updateAdaptiveAfterTrade(state, result.result);
    }

    save(tenantId);
    return;
  }

  /* ===== ENTRY ===== */

  if (plan.action !== "BUY" || state.position) {
    save(tenantId);
    return;
  }

  const portfolioCheck = portfolioManager.evaluate({
    tenantId,
    symbol,
    equity: state.equity,
    proposedRiskPct: plan.riskPct,
    paperState: state,
  });

  if (!portfolioCheck.allow) {
    save(tenantId);
    return;
  }

  let adjustedRisk =
    portfolioCheck.adjustedRiskPct *
    (risk.riskMultiplier || 1);

  adjustedRisk *= state.adaptive.riskBoost;

  adjustedRisk = clamp(adjustedRisk, 0.001, 0.06);

  const result = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action: "BUY",
    price,
    riskPct: adjustedRisk,
    state,
    ts,
  });

  if (result?.narration) {
    narrate(
      tenantId,
      result.narration.text,
      result.narration.meta
    );
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

  riskManager.resetTenant(tenantId);
  portfolioManager.resetTenant(tenantId);
}

module.exports = {
  tick,
  snapshot,
  start,
  hardReset,
};
