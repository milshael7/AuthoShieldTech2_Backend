// backend/src/services/liveTrader.js
// Live Trading Engine — Phase 2 FINAL
// Architecture: liveTrader → tradeBrain → strategyEngine
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

function nowIso() {
  return new Date().toISOString();
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 3,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    lastPrice: null,

    stats: {
      ticksSeen: 0,
      lastDecision: "WAIT",
      confidence: 0,
      edge: 0,
      lastReason: "not_started",
    },

    intents: [],
    orders: [],
    lastError: null,

    config: {
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
  state.lastPrice = p;

  // 🔥 USE UNIFIED BRAIN
  const plan = makeDecision({
    symbol,
    last: p,
    paper: {
      learnStats: {},
      limits: {},
      config: {},
    },
  });

  state.stats.lastDecision = plan.action;
  state.stats.confidence = plan.confidence;
  state.stats.edge = plan.edge;
  state.stats.lastReason = plan.blockedReason || plan.action;

  if (state.enabled && plan.action !== "WAIT") {
    const intent = {
      id: `${Date.now()}_${Math.random()
        .toString(16)
        .slice(2)}`,
      ts: Date.now(),
      symbol,
      side: plan.action,
      confidence: plan.confidence,
      edge: plan.edge,
      reason: plan.blockedReason || plan.action,
      executed: false,
    };

    state.intents.push(intent);
    state.intents = state.intents.slice(-200);

    if (state.execute) {
      intent.execution = {
        status: "adapter_missing",
        note: "Execution adapter not wired.",
      };
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
