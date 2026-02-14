// backend/src/services/liveTrader.js
// Phase 10 — Institutional Live Engine (Router Integrated)
// Strategy → Risk → Portfolio → ExchangeRouter
// Failover Ready • Circuit Protected • Tenant Safe

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");
const exchangeRouter = require("./exchangeRouter");

/* ================= CONFIG ================= */

const BASE_PATH =
  process.env.LIVE_TRADER_STATE_DIR ||
  path.join("/tmp", "live_trader");

const LIVE_REFERENCE_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

const MAX_INTENTS = 200;
const MAX_ORDERS = 500;

/* ================= ENV FLAGS ================= */

function envTrue(name) {
  const v = String(process.env[name] || "")
    .toLowerCase()
    .trim();
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

function validAction(a) {
  return a === "BUY" || a === "SELL" || a === "CLOSE";
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 10,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    lastPrice: null,
    volatility: 0.002,
    equity: LIVE_REFERENCE_BALANCE,

    stats: {
      ticksSeen: 0,
      lastDecision: "WAIT",
      confidence: 0,
      edge: 0,
      lastReason: "boot",
    },

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      trendEdge: 0,
    },

    limits: {
      halted: false,
      haltReason: null,
      cooling: false,
    },

    trades: [],
    intents: [],
    orders: [],
    executionAudit: [],
    lastError: null,
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
      const raw = JSON.parse(
        fs.readFileSync(file, "utf-8")
      );
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

async function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  refreshFlags(state);

  const p = safeNum(price, null);
  if (!Number.isFinite(p)) return;

  state.stats.ticksSeen++;
  state.learnStats.ticksSeen++;

  updateVolatility(state, p);

  /* ========= RISK ========= */

  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    volatility: state.volatility,
    trades: state.trades,
    ts,
  });

  state.limits.halted = risk.halted;
  state.limits.haltReason = risk.haltReason || null;
  state.limits.cooling = risk.cooling;

  if (risk.halted || risk.cooling) {
    save(tenantId);
    return;
  }

  /* ========= STRATEGY ========= */

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

  if (!state.enabled || !validAction(plan.action) || plan.action === "WAIT") {
    save(tenantId);
    return;
  }

  /* ========= PORTFOLIO ========= */

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

  /* ========= INTENT ========= */

  const adjustedRisk = clamp(
    portfolioCheck.adjustedRiskPct *
      (risk.riskMultiplier || 1),
    0.001,
    0.05
  );

  const intent = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts,
    symbol,
    side: plan.action,
    confidence: plan.confidence,
    edge: plan.edge,
    riskPct: adjustedRisk,
    reason: plan.reason,
    executed: false,
  };

  state.intents.push(intent);
  if (state.intents.length > MAX_INTENTS) {
    state.intents = state.intents.slice(-MAX_INTENTS);
  }

  /* ========= EXECUTION ROUTER ========= */

  if (state.execute) {
    try {
      const result = await exchangeRouter.routeLiveOrder({
        tenantId,
        symbol,
        side: plan.action,
        riskPct: adjustedRisk,
        price: p,
        ts,
      });

      intent.executed = true;
      intent.executionResult = result;

      state.orders.push({
        ts,
        symbol,
        side: plan.action,
        exchange: result?.exchange || null,
        ok: result?.ok || false,
        result,
      });

      if (state.orders.length > MAX_ORDERS) {
        state.orders = state.orders.slice(-MAX_ORDERS);
      }

      state.executionAudit.push({
        ts,
        symbol,
        side: plan.action,
        exchange: result?.exchange,
        ok: result?.ok,
      });

    } catch (err) {
      state.lastError = String(err?.message || err);
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
    equity: state.equity,
    intents: state.intents.slice(-50),
    orders: state.orders.slice(-50),
    executionAudit: state.executionAudit.slice(-50),
    lastError: state.lastError,
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
};
