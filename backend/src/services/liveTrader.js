// backend/src/services/liveTrader.js
// Phase 4 FINAL
// Fully aligned with Adaptive StrategyEngine + tradeBrain
// Execution still locked (adapter required)

const fs = require("fs");
const path = require("path");
const { makeDecision } = require("./tradeBrain");

/* ================= CONFIG ================= */

const BASE_PATH =
  process.env.LIVE_TRADER_STATE_DIR ||
  path.join("/tmp", "live_trader");

const LIVE_REFERENCE_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

/* ================= ENV FLAGS ================= */

function envTrue(name) {
  const v = String(process.env[name] || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function isEnabled() {
  return envTrue("LIVE_TRADING_ENABLED");
}

function isExecuteEnabled() {
  return envTrue("LIVE_TRADING_EXECUTE");
}

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `live_${tenantId}.json`);
}

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowIso() {
  return new Date().toISOString();
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 5,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    lastPrice: null,
    volatility: 0.002,

    stats: {
      ticksSeen: 0,
      lastDecision: "WAIT",
      confidence: 0,
      edge: 0,
      lastReason: "not_started",
    },

    // unified brain structure
    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      trendEdge: 0,
    },

    limits: {
      tradesToday: 0,
      lossesToday: 0,
      halted: false,
      haltReason: null,
    },

    trades: [], // 🔥 required for adaptive learning

    intents: [],
    orders: [],
    lastError: null,

    config: {
      baselinePct: 0.01,
      maxPct: 0.02,
      slPct: 0.005,
      tpPct: 0.01,
      LIVE_REFERENCE_BALANCE,
    },
  };
}

const STATES = new Map();

/* ================= PERSIST ================= */

function load(tenantId) {
  if (STATES.has(tenantId)) return STATES.get(tenantId);

  const file = statePath(tenantId);
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

  state.updatedAt = nowIso();
  try {
    fs.writeFileSync(
      statePath(tenantId),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

function refreshFlags(state) {
  state.enabled = isEnabled();
  state.execute = state.enabled && isExecuteEnabled();

  if (!state.enabled) state.mode = "live-disabled";
  else if (state.execute) state.mode = "live-executing";
  else state.mode = "live-armed";
}

/* ================= VOLATILITY ================= */

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

/* ================= LIFECYCLE ================= */

function start(tenantId) {
  const state = load(tenantId);
  state.running = true;
  refreshFlags(state);
  save(tenantId);
}

function stop(tenantId) {
  const state = load(tenantId);
  state.running = false;
  save(tenantId);
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  refreshFlags(state);

  const p = safeNum(price, null);
  if (!Number.isFinite(p)) return;

  state.stats.ticksSeen++;
  state.learnStats.ticksSeen++;

  updateVolatility(state, p);

  // 🔥 Unified adaptive decision
  const plan = makeDecision({
    tenantId,
    symbol,
    last: p,
    paper: state,
  });

  state.stats.lastDecision = plan.action;
  state.stats.confidence = plan.confidence;
  state.stats.edge = plan.edge;
  state.stats.lastReason = plan.reason;

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.trendEdge = plan.edge;

  if (state.enabled && plan.action !== "WAIT") {
    const intent = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ts,
      symbol,
      side: plan.action,
      confidence: plan.confidence,
      edge: plan.edge,
      reason: plan.reason,
      executed: false,
    };

    state.intents.push(intent);
    state.intents = state.intents.slice(-200);

    if (state.execute) {
      intent.execution = {
        status: "adapter_missing",
        note: "Execution adapter not wired.",
      };

      // placeholder trade log for adaptive feedback
      state.trades.push({
        time: ts,
        symbol,
        type: plan.action,
        profit: 0, // will be real when adapter connected
      });

      state.trades = state.trades.slice(-200);
    }
  }

  save(tenantId);
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    running: state.running,
    enabled: state.enabled,
    execute: state.execute,
    mode: state.mode,
    stats: state.stats,
    intents: state.intents.slice(-50),
    trades: state.trades.slice(-50),
    lastError: state.lastError,
    config: {
      LIVE_TRADING_ENABLED: state.enabled,
      LIVE_TRADING_EXECUTE: state.execute,
      LIVE_REFERENCE_BALANCE,
    },
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
};
