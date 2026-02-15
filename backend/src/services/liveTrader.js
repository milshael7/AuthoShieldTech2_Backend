// backend/src/services/liveTrader.js
// Phase 15 — Institutional Live Engine (Reinforced)
// Paper Profit Gate • Capital Detection • AI Reinforcement
// Cross Margin • Multi-Timeframe Fusion
// Friday Shutdown • Production Safe

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const exchangeRouter = require("./exchangeRouter");
const aiBrain = require("./aiBrain");
const riskManager = require("./riskManager");

/* =========================================================
   CONFIG
========================================================= */

const BASE_PATH =
  process.env.LIVE_TRADER_STATE_DIR ||
  path.join("/tmp", "live_trader");

const START_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

const MAX_ORDERS = 500;
const MAX_TRADES = 1000;

/* =========================================================
   HELPERS
========================================================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `live_${tenantId}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function envTrue(name) {
  const v = String(process.env[name] || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function isFridayShutdown(ts) {
  const d = new Date(ts);
  return d.getUTCDay() === 5 && d.getUTCHours() >= 20;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* =========================================================
   DEFAULT STATE
========================================================= */

function defaultState() {
  return {
    version: 15,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    cashBalance: START_BALANCE,
    equity: START_BALANCE,

    leverage: 3,
    initialMarginPct: 1 / 3,
    maintenanceMarginPct: 0.25,
    marginUsed: 0,
    liquidationFlag: false,

    volatility: 0,
    regime: "NORMAL",

    lastPrices: {},
    positions: {},

    timeframes: {
      micro: [],
      short: [],
      medium: [],
    },

    fusedSignal: {
      direction: "NEUTRAL",
      score: 0,
    },

    trades: [],
    orders: [],
    lastError: null,
  };
}

const STATES = new Map();

/* =========================================================
   PERSISTENCE
========================================================= */

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
  state.updatedAt = nowIso();

  try {
    fs.writeFileSync(
      statePath(tenantId),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

function refreshFlags(state) {
  state.enabled = envTrue("LIVE_TRADING_ENABLED");
  state.execute = state.enabled && envTrue("LIVE_TRADING_EXECUTE");

  if (!state.enabled) state.mode = "live-disabled";
  else if (state.execute) state.mode = "live-executing";
  else state.mode = "live-armed";
}

/* =========================================================
   EQUITY
========================================================= */

function recalcEquity(state) {
  let unrealized = 0;
  let exposure = 0;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    const price = state.lastPrices[symbol];
    if (!price || !pos.qty) continue;

    unrealized += (price - pos.avgEntry) * pos.qty;
    exposure += Math.abs(pos.qty * price);
  }

  state.equity = state.cashBalance + unrealized;
  state.marginUsed = exposure * state.initialMarginPct;
}

function maintenanceRequired(state) {
  return state.marginUsed * state.maintenanceMarginPct;
}

/* =========================================================
   POSITION ENGINE
========================================================= */

function applyFill(state, { symbol, side, price, qty }) {
  state.positions[symbol] = state.positions[symbol] || {
    qty: 0,
    avgEntry: 0,
    realizedPnL: 0,
  };

  const pos = state.positions[symbol];
  const signedQty = side === "BUY" ? qty : -qty;
  const newQty = pos.qty + signedQty;

  if (
    pos.qty === 0 ||
    Math.sign(pos.qty) === Math.sign(newQty)
  ) {
    const totalCost =
      pos.avgEntry * pos.qty + price * signedQty;

    pos.qty = newQty;
    pos.avgEntry =
      pos.qty !== 0 ? totalCost / pos.qty : 0;
  } else {
    const closingQty = Math.min(
      Math.abs(pos.qty),
      Math.abs(signedQty)
    );

    const pnl =
      (price - pos.avgEntry) *
      closingQty *
      Math.sign(pos.qty);

    pos.realizedPnL += pnl;
    state.cashBalance += pnl;

    state.trades.push({
      ts: Date.now(),
      symbol,
      qty: closingQty,
      entry: pos.avgEntry,
      exit: price,
      profit: pnl,
    });

    if (state.trades.length > MAX_TRADES)
      state.trades = state.trades.slice(-MAX_TRADES);

    // 🔥 Reinforcement to AI
    aiBrain.recordTradeOutcome({ pnl });
  }

  recalcEquity(state);
}

/* =========================================================
   MAIN TICK
========================================================= */

async function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  if (isFridayShutdown(ts)) return;

  refreshFlags(state);

  state.lastPrices[symbol] = price;
  recalcEquity(state);

  // 🔥 Risk evaluation for live capital discipline
  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    trades: state.trades,
    marginUsed: state.marginUsed,
    maintenanceRequired: maintenanceRequired(state),
    ts,
  });

  if (risk.halted) {
    save(tenantId);
    return;
  }

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
  });

  if (
    !state.enabled ||
    !state.execute ||
    plan.action === "WAIT"
  ) {
    save(tenantId);
    return;
  }

  try {
    const result = await exchangeRouter.routeLiveOrder({
      tenantId,
      symbol,
      side: plan.action,
      riskPct: plan.riskPct * risk.riskMultiplier,
      price,
      ts,
    });

    if (result?.ok && result?.result?.order?.filledQty) {
      applyFill(state, {
        symbol,
        side: plan.action,
        price,
        qty: result.result.order.filledQty,
      });
    }

    state.orders.push({
      ts,
      symbol,
      side: plan.action,
      ok: result?.ok,
    });

    if (state.orders.length > MAX_ORDERS)
      state.orders = state.orders.slice(-MAX_ORDERS);

  } catch (err) {
    state.lastError = String(err?.message || err);
  }

  save(tenantId);
}

/* =========================================================
   LIFECYCLE
========================================================= */

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

/* =========================================================
   SNAPSHOT
========================================================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    mode: state.mode,
    cash: state.cashBalance,
    equity: state.equity,
    marginUsed: state.marginUsed,
    liquidation: state.liquidationFlag,
    positions: state.positions,
    trades: state.trades.slice(-10),
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
};
