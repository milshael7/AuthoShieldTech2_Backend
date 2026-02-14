// backend/src/services/liveTrader.js
// Phase 14 — Institutional Live Engine
// Cross Margin • Dynamic Leverage • Fill Engine • Auto Liquidation
// Router Integrated • Production Structured

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const exchangeRouter = require("./exchangeRouter");

/* ================= CONFIG ================= */

const BASE_PATH =
  process.env.LIVE_TRADER_STATE_DIR ||
  path.join("/tmp", "live_trader");

const START_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

const MAX_ORDERS = 500;
const MAX_POSITION_PER_SYMBOL_PCT = 0.4; // 40% of equity cap

/* ================= HELPERS ================= */

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 14,
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
    circuitBreaker: false,

    lastPrices: {},
    positions: {},

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

/* ================= POSITION ENGINE ================= */

function applyFill(state, { symbol, side, price, qty }) {
  state.positions[symbol] = state.positions[symbol] || {
    qty: 0,
    avgEntry: 0,
    realizedPnL: 0,
  };

  const pos = state.positions[symbol];
  const signedQty = side === "BUY" ? qty : -qty;
  const newQty = pos.qty + signedQty;

  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(newQty)) {
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

    pos.qty = newQty;

    if (pos.qty === 0) {
      pos.avgEntry = 0;
    } else {
      pos.avgEntry = price;
    }
  }

  recalcEquity(state);
}

/* ================= AUTO LIQUIDATION ================= */

async function autoLiquidate(tenantId, state) {
  state.liquidationFlag = true;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    if (!pos.qty) continue;

    const side = pos.qty > 0 ? "SELL" : "BUY";
    const qty = Math.abs(pos.qty);

    try {
      await exchangeRouter.routeLiveOrder({
        tenantId,
        symbol,
        side,
        qty,
        forceClose: true,
      });

      state.positions[symbol] = {
        qty: 0,
        avgEntry: 0,
        realizedPnL: 0,
      };
    } catch (err) {
      state.lastError = String(err?.message || err);
    }
  }

  recalcEquity(state);
}

/* ================= TICK ================= */

async function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running || state.circuitBreaker) return;

  refreshFlags(state);

  state.lastPrices[symbol] = price;
  recalcEquity(state);

  if (
    state.marginUsed > 0 &&
    state.equity <= maintenanceRequired(state)
  ) {
    await autoLiquidate(tenantId, state);
    save(tenantId);
    return;
  }

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

  const maxSymbolExposure =
    state.equity * MAX_POSITION_PER_SYMBOL_PCT;

  const riskCapital = state.equity * plan.riskPct;
  const positionValue = clamp(
    riskCapital * state.leverage,
    0,
    maxSymbolExposure
  );

  const qty = positionValue / price;

  try {
    const result = await exchangeRouter.routeLiveOrder({
      tenantId,
      symbol,
      side: plan.action,
      qty,
      price,
      ts,
    });

    if (result?.ok) {
      applyFill(state, {
        symbol,
        side: plan.action,
        price,
        qty,
      });
    } else {
      state.lastError = result?.error;
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
    state.circuitBreaker = true;
  }

  save(tenantId);
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

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    mode: state.mode,
    cash: state.cashBalance,
    equity: state.equity,
    leverage: state.leverage,
    marginUsed: state.marginUsed,
    maintenanceRequired: maintenanceRequired(state),
    liquidation: state.liquidationFlag,
    circuitBreaker: state.circuitBreaker,
    positions: state.positions,
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
};
