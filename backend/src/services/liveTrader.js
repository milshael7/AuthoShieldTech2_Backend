// backend/src/services/liveTrader.js
// Phase 25 — Institutional Autonomous Live Engine
// Cross Margin • Auto Liquidation • Multi-Timeframe Fusion
// VaR Engine • Kelly Sizing • Regime Detection • Crash Protection
// Router Integrated • Production Hardened

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
    version: 25,
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

    volatility: 0.01,
    prevPrice: null,

    riskMetrics: {
      var95: 0,
      portfolioHeat: 0,
      regime: "NORMAL",
    },

    performance: {
      winRate: 0.5,
      kellyFraction: 0.02,
    },

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
}

function maintenanceRequired(state) {
  return state.marginUsed * state.maintenanceMarginPct;
}

/* ================= VOLATILITY ================= */

function updateVolatility(state, price) {
  if (!state.prevPrice) {
    state.prevPrice = price;
    return;
  }

  const change =
    Math.abs(price - state.prevPrice) /
    state.prevPrice;

  state.volatility =
    state.volatility * 0.9 + change * 0.1;

  state.prevPrice = price;
}

/* ================= VaR ================= */

function calculateVaR(state) {
  const prices = Object.values(state.lastPrices);
  if (prices.length < 2) return;

  const returns = [];

  for (let i = 1; i < prices.length; i++) {
    returns.push(
      (prices[i] - prices[i - 1]) / prices[i - 1]
    );
  }

  if (!returns.length) return;

  const mean =
    returns.reduce((a, b) => a + b, 0) /
    returns.length;

  const variance =
    returns.reduce(
      (a, r) => a + Math.pow(r - mean, 2),
      0
    ) / returns.length;

  const stdDev = Math.sqrt(variance);

  state.riskMetrics.var95 =
    1.65 * stdDev * state.equity;

  state.riskMetrics.portfolioHeat =
    state.marginUsed > 0
      ? state.marginUsed / state.equity
      : 0;
}

/* ================= REGIME ================= */

function detectRegime(state) {
  const vol = state.volatility;

  if (vol > 0.06) state.riskMetrics.regime = "CRASH";
  else if (vol > 0.03) state.riskMetrics.regime = "HIGH_VOL";
  else if (vol < 0.003) state.riskMetrics.regime = "LOW_VOL";
  else state.riskMetrics.regime = "NORMAL";
}

/* ================= KELLY ================= */

function updateKellyFraction(state) {
  const trades = state.trades;
  if (trades.length < 10) return;

  const wins = trades.filter(t => t.profit > 0).length;
  const total = trades.length;

  const winRate = wins / total;

  const avgWin =
    trades
      .filter(t => t.profit > 0)
      .reduce((a, b) => a + b.profit, 0) /
    (wins || 1);

  const avgLoss =
    Math.abs(
      trades
        .filter(t => t.profit <= 0)
        .reduce((a, b) => a + b.profit, 0)
    ) / (total - wins || 1);

  if (!avgLoss) return;

  const k =
    winRate - (1 - winRate) / (avgWin / avgLoss);

  state.performance.winRate = winRate;
  state.performance.kellyFraction =
    clamp(k, 0.01, 0.25);
}

/* ================= TIMEFRAME ENGINE ================= */

function updateTimeframes(state, price) {
  const tf = state.timeframes;

  tf.micro.push(price);
  tf.short.push(price);
  tf.medium.push(price);

  if (tf.micro.length > 20) tf.micro = tf.micro.slice(-20);
  if (tf.short.length > 100) tf.short = tf.short.slice(-100);
  if (tf.medium.length > 400) tf.medium = tf.medium.slice(-400);
}

function ema(values, length) {
  if (values.length < length) return null;

  const k = 2 / (length + 1);
  let emaVal = values[0];

  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

function fuseSignals(state) {
  const tf = state.timeframes;
  if (tf.medium.length < 50) return;

  const microMomentum =
    tf.micro[tf.micro.length - 1] -
    tf.micro[0];

  const shortFast = ema(tf.short, 20);
  const shortSlow = ema(tf.short, 50);
  const medFast = ema(tf.medium, 50);
  const medSlow = ema(tf.medium, 200);

  let score = 0;

  if (microMomentum > 0) score += 0.5;
  if (microMomentum < 0) score -= 0.5;

  if (shortFast > shortSlow) score += 1;
  if (shortFast < shortSlow) score -= 1;

  if (medFast > medSlow) score += 1.5;
  if (medFast < medSlow) score -= 1.5;

  state.fusedSignal.score = score;

  if (score > 1) state.fusedSignal.direction = "BUY";
  else if (score < -1) state.fusedSignal.direction = "SELL";
  else state.fusedSignal.direction = "NEUTRAL";
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

  updateVolatility(state, price);
  updateTimeframes(state, price);
  fuseSignals(state);

  recalcEquity(state);
  calculateVaR(state);
  detectRegime(state);
  updateKellyFraction(state);

  if (state.riskMetrics.regime === "CRASH") {
    state.enabled = false;
    save(tenantId);
    return;
  }

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

  if (
    !state.enabled ||
    plan.action === "WAIT" ||
    (state.fusedSignal.direction !== "NEUTRAL" &&
      plan.action !== state.fusedSignal.direction)
  ) {
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
      riskPct:
        plan.riskPct *
        state.performance.kellyFraction,
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
    cash: state.cashBalance,
    equity: state.equity,
    leverage: state.leverage,
    marginUsed: state.marginUsed,
    maintenanceRequired: maintenanceRequired(state),
    liquidation: state.liquidationFlag,
    fusedSignal: state.fusedSignal,
    regime: state.riskMetrics.regime,
    var95: state.riskMetrics.var95,
    kelly: state.performance.kellyFraction,
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
