// backend/src/services/liveTrader.js
// Phase 24 — Institutional Live Engine
// Volatility-Adaptive Leverage + Margin Ratio Engine
// Cross Margin • Tiered Liquidation • Risk Compression

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

/* === Margin Risk Buffers === */

const LIQUIDATION_BUFFER = 1.15;
const CRITICAL_BUFFER = 1.02;

/* === Volatility Thresholds === */

const LOW_VOL = 0.003;
const HIGH_VOL = 0.02;

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

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 24,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,
    mode: "live-disabled",

    cashBalance: START_BALANCE,
    equity: START_BALANCE,

    leverage: 3,
    dynamicLeverage: 3,
    initialMarginPct: 1 / 3,
    maintenanceMarginPct: 0.25,

    marginUsed: 0,
    marginRatio: Infinity,
    marginWarning: false,
    marginCritical: false,
    liquidationCount: 0,

    volatility: 0.005,

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

/* ================= VOLATILITY ENGINE ================= */

function updateVolatility(state, symbol, price) {
  const prev = state.lastPrices[symbol];
  if (!prev) return;

  const change = Math.abs(price - prev) / prev;

  state.volatility =
    state.volatility * 0.9 + change * 0.1;
}

/* ================= LEVERAGE ENGINE ================= */

function updateDynamicLeverage(state) {
  let baseLeverage = 3;

  if (state.volatility < LOW_VOL)
    baseLeverage = 5;

  if (state.volatility > HIGH_VOL)
    baseLeverage = 1.5;

  if (state.marginWarning)
    baseLeverage *= 0.75;

  if (state.marginCritical)
    baseLeverage *= 0.5;

  if (state.liquidationCount > 0)
    baseLeverage *= 0.7;

  state.dynamicLeverage = Math.max(1, baseLeverage);
  state.initialMarginPct = 1 / state.dynamicLeverage;
}

/* ================= EQUITY + MARGIN ================= */

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

  const maintenance =
    state.marginUsed * state.maintenanceMarginPct;

  state.marginRatio =
    maintenance > 0
      ? state.equity / maintenance
      : Infinity;

  state.marginWarning =
    state.marginRatio <= LIQUIDATION_BUFFER;

  state.marginCritical =
    state.marginRatio <= CRITICAL_BUFFER;
}

/* ================= AUTO LIQUIDATION ================= */

async function autoLiquidate(tenantId, state) {
  state.liquidationCount++;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    if (!pos.qty) continue;

    const side = pos.qty > 0 ? "SELL" : "BUY";
    const qty = Math.abs(pos.qty);
    const price = state.lastPrices[symbol];

    try {
      const result =
        await exchangeRouter.routeLiveOrder({
          tenantId,
          symbol,
          side,
          qty,
          forceClose: true,
        });

      if (result?.ok) {
        const pnl =
          (price - pos.avgEntry) *
          pos.qty;

        state.cashBalance += pnl;

        state.positions[symbol] = {
          qty: 0,
          avgEntry: 0,
          realizedPnL: 0,
        };

        state.trades.push({
          ts: Date.now(),
          symbol,
          forced: true,
          qty,
          exit: price,
          pnl,
        });
      }

    } catch (err) {
      state.lastError = String(err?.message || err);
    }
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

  updateVolatility(state, symbol, price);

  state.lastPrices[symbol] = price;

  updateDynamicLeverage(state);

  recalcEquity(state);

  if (state.marginRatio <= 1) {
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

  try {
    const result =
      await exchangeRouter.routeLiveOrder({
        tenantId,
        symbol,
        side: plan.action,
        riskPct: plan.riskPct,
        price,
        ts,
      });

    state.orders.push({
      ts,
      symbol,
      side: plan.action,
      exchange: result?.exchange,
      ok: result?.ok,
    });

    if (state.orders.length > MAX_ORDERS)
      state.orders = state.orders.slice(-MAX_ORDERS);

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
    equity: state.equity,
    dynamicLeverage: state.dynamicLeverage,
    marginUsed: state.marginUsed,
    marginRatio: state.marginRatio,
    warning: state.marginWarning,
    critical: state.marginCritical,
    liquidationCount: state.liquidationCount,
    volatility: state.volatility,
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
