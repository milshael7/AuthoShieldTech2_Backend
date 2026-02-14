// backend/src/services/liveTrader.js
// Phase 11.5 — Institutional Live Engine
// Spot Position Book + Real-Time Equity Engine

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

const START_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

const MAX_ORDERS = 500;

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `live_${tenantId}.json`);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowIso() {
  return new Date().toISOString();
}

function envTrue(name) {
  const v = String(process.env[name] || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 11.5,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    cashBalance: START_BALANCE,
    equity: START_BALANCE,

    lastPrices: {},

    positions: {}, // symbol → { qty, avgEntry, realizedPnL }

    trades: [],
    orders: [],
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

/* ================= EQUITY ENGINE ================= */

function recalcEquity(state) {
  let unrealized = 0;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    const price = state.lastPrices[symbol];
    if (!price) continue;

    unrealized += (price - pos.avgEntry) * pos.qty;
  }

  state.equity = state.cashBalance + unrealized;
}

/* ================= POSITION APPLY ================= */

function applyFill(state, { symbol, side, price, qty }) {
  state.positions[symbol] = state.positions[symbol] || {
    qty: 0,
    avgEntry: 0,
    realizedPnL: 0,
  };

  const pos = state.positions[symbol];

  if (side === "BUY") {
    const totalCost =
      pos.avgEntry * pos.qty + price * qty;

    pos.qty += qty;
    pos.avgEntry = totalCost / pos.qty;

    state.cashBalance -= price * qty;
  }

  if (side === "SELL") {
    const closingQty = Math.min(qty, pos.qty);
    const pnl = (price - pos.avgEntry) * closingQty;

    pos.qty -= closingQty;
    pos.realizedPnL += pnl;

    state.cashBalance += price * closingQty;

    state.trades.push({
      ts: Date.now(),
      symbol,
      qty: closingQty,
      entry: pos.avgEntry,
      exit: price,
      profit: pnl,
    });

    if (pos.qty <= 0) delete state.positions[symbol];
  }

  recalcEquity(state);
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

  state.lastPrices[symbol] = price;
  recalcEquity(state);

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
  });

  if (!state.enabled || plan.action === "WAIT") {
    save(tenantId);
    return;
  }

  if (!state.execute) {
    save(tenantId);
    return;
  }

  try {
    const result = await exchangeRouter.routeLiveOrder({
      tenantId,
      symbol,
      side: plan.action,
      riskPct: plan.riskPct,
      price,
      ts,
    });

    if (result?.ok && result?.result?.filledQty) {
      applyFill(state, {
        symbol,
        side: plan.action,
        price,
        qty: result.result.filledQty,
      });
    }

    state.orders.push({
      ts,
      symbol,
      side: plan.action,
      exchange: result?.exchange,
      ok: result?.ok,
    });

    if (state.orders.length > MAX_ORDERS) {
      state.orders = state.orders.slice(-MAX_ORDERS);
    }

  } catch (err) {
    state.lastError = String(err?.message || err);
  }

  save(tenantId);
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    mode: state.mode,
    cash: state.cashBalance,
    equity: state.equity,
    positions: state.positions,
    orders: state.orders.slice(-50),
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
};
