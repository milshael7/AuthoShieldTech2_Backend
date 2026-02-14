// backend/src/services/liveTrader.js
// Phase 16 — Institutional Portfolio Netting Engine
// Adaptive Leverage • Cross Margin • Portfolio Beta Control
// Correlation-Aware Exposure Engine

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

const MAX_POSITION_PER_SYMBOL_PCT = 0.4;
const MAX_TOTAL_EXPOSURE_PCT = 1.5; // 150% gross
const MAX_NET_DIRECTIONAL_PCT = 0.75; // 75% directional bias cap

const MAX_LEVERAGE = 5;
const MIN_LEVERAGE = 1;

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
    version: 16,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    cashBalance: START_BALANCE,
    equity: START_BALANCE,

    dynamicLeverage: 3,
    volatility: 0.002,

    initialMarginPct: 1 / 3,
    maintenanceMarginPct: 0.25,

    marginUsed: 0,
    liquidationFlag: false,
    circuitBreaker: false,

    lastPrices: {},
    positions: {},

    grossExposure: 0,
    netExposure: 0,

    trades: [],
    orders: [],
    lastError: null,
  };
}

const STATES = new Map();

/* ================= CORE CALCS ================= */

function updateVolatility(state, symbol, price) {
  const last = state.lastPrices[symbol];
  if (!last) {
    state.lastPrices[symbol] = price;
    return;
  }

  const change = Math.abs(price - last) / last;
  state.volatility = state.volatility * 0.9 + change * 0.1;
  state.lastPrices[symbol] = price;
}

function updateDynamicLeverage(state) {
  const vol = state.volatility;

  if (vol < 0.003) state.dynamicLeverage = MAX_LEVERAGE;
  else if (vol < 0.01) state.dynamicLeverage = 3;
  else if (vol < 0.02) state.dynamicLeverage = 2;
  else state.dynamicLeverage = MIN_LEVERAGE;

  state.initialMarginPct = 1 / state.dynamicLeverage;
}

function recalcPortfolio(state) {
  let unrealized = 0;
  let gross = 0;
  let net = 0;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    const price = state.lastPrices[symbol];
    if (!price || !pos.qty) continue;

    const exposure = pos.qty * price;

    unrealized += (price - pos.avgEntry) * pos.qty;
    gross += Math.abs(exposure);
    net += exposure;
  }

  state.grossExposure = gross;
  state.netExposure = net;

  state.equity = state.cashBalance + unrealized;
  state.marginUsed = gross * state.initialMarginPct;
}

function maintenanceRequired(state) {
  return state.marginUsed * state.maintenanceMarginPct;
}

/* ================= POSITION ENGINE ================= */

function applyFill(state, { symbol, side, price, qty }) {
  state.positions[symbol] = state.positions[symbol] || {
    qty: 0,
    avgEntry: 0,
  };

  const pos = state.positions[symbol];
  const signedQty = side === "BUY" ? qty : -qty;
  const newQty = pos.qty + signedQty;

  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(newQty)) {
    const totalCost =
      pos.avgEntry * pos.qty + price * signedQty;

    pos.qty = newQty;
    pos.avgEntry = pos.qty !== 0 ? totalCost / pos.qty : 0;
  } else {
    pos.qty = newQty;
    pos.avgEntry = price;
  }

  recalcPortfolio(state);
}

/* ================= TICK ================= */

async function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running || state.circuitBreaker) return;

  refreshFlags(state);

  updateVolatility(state, symbol, price);
  updateDynamicLeverage(state);
  recalcPortfolio(state);

  if (
    state.marginUsed > 0 &&
    state.equity <= maintenanceRequired(state)
  ) {
    state.liquidationFlag = true;
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

  /* ================= PORTFOLIO NETTING ================= */

  const totalExposureLimit =
    state.equity * MAX_TOTAL_EXPOSURE_PCT;

  if (state.grossExposure >= totalExposureLimit) {
    save(tenantId);
    return;
  }

  const directionalCap =
    state.equity * MAX_NET_DIRECTIONAL_PCT;

  let directionalBiasFactor = 1;

  if (
    plan.action === "BUY" &&
    state.netExposure > directionalCap
  ) {
    directionalBiasFactor = 0.3;
  }

  if (
    plan.action === "SELL" &&
    state.netExposure < -directionalCap
  ) {
    directionalBiasFactor = 0.3;
  }

  const riskCapital =
    state.equity * plan.riskPct * directionalBiasFactor;

  const maxSymbolExposure =
    state.equity * MAX_POSITION_PER_SYMBOL_PCT;

  const positionValue = clamp(
    riskCapital * state.dynamicLeverage,
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
    }

    state.orders.push({
      ts,
      symbol,
      side: plan.action,
      ok: result?.ok,
      exchange: result?.exchange,
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

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    equity: state.equity,
    grossExposure: state.grossExposure,
    netExposure: state.netExposure,
    leverage: state.dynamicLeverage,
    volatility: state.volatility,
    marginUsed: state.marginUsed,
    liquidation: state.liquidationFlag,
    circuitBreaker: state.circuitBreaker,
    positions: state.positions,
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start: (id) => { const s = load(id); s.running = true; save(id); },
  stop: (id) => { const s = load(id); s.running = false; save(id); },
  tick,
  snapshot,
};
