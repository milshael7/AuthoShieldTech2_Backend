// backend/src/services/liveTrader.js
// Phase 20 — Reinforcement Execution Optimizer
// Regime + Performance + Signal Intelligence

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
const PERFORMANCE_WINDOW = 20;
const SIGNAL_WINDOW = 50;

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
    version: 20,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,

    cashBalance: START_BALANCE,
    equity: START_BALANCE,
    peakEquity: START_BALANCE,

    volatility: 0.002,
    acceleration: 0,
    regime: "LOW_VOL",

    dynamicLeverage: 3,

    grossExposure: 0,
    netExposure: 0,

    performance: {
      recentTrades: [],
      winRate: 0.5,
      score: 0.5,
    },

    signalIntelligence: {
      stats: {}, // keyed by signalKey
    },

    lastPrices: {},
    positions: {},

    trades: [],
    orders: [],
    lastError: null,
  };
}

const STATES = new Map();

/* ================= SIGNAL INTELLIGENCE ================= */

function buildSignalKey(symbol, regime, side) {
  return `${symbol}_${regime}_${side}`;
}

function updateSignalStats(state, signalKey, pnl) {
  const intel = state.signalIntelligence;

  intel.stats[signalKey] =
    intel.stats[signalKey] || {
      trades: [],
      winRate: 0.5,
      score: 1,
    };

  const entry = intel.stats[signalKey];

  entry.trades.push(pnl);
  if (entry.trades.length > SIGNAL_WINDOW)
    entry.trades = entry.trades.slice(-SIGNAL_WINDOW);

  const wins = entry.trades.filter(p => p > 0).length;
  entry.winRate =
    entry.trades.length > 0
      ? wins / entry.trades.length
      : 0.5;

  const avgPnL =
    entry.trades.reduce((a, b) => a + b, 0) /
    Math.max(entry.trades.length, 1);

  let score =
    entry.winRate * 0.6 +
    clamp(avgPnL / 1000, -1, 1) * 0.4;

  entry.score = clamp(score, 0.3, 1.7);
}

/* ================= PERFORMANCE ================= */

function updatePerformance(state, pnl) {
  const perf = state.performance;

  perf.recentTrades.push(pnl);
  if (perf.recentTrades.length > PERFORMANCE_WINDOW)
    perf.recentTrades = perf.recentTrades.slice(-PERFORMANCE_WINDOW);

  const wins = perf.recentTrades.filter(p => p > 0).length;
  perf.winRate =
    perf.recentTrades.length > 0
      ? wins / perf.recentTrades.length
      : 0.5;

  let score = perf.winRate;
  perf.score = clamp(score, 0.3, 1.5);
}

/* ================= REGIME ================= */

function updateMarketMetrics(state, symbol, price) {
  const last = state.lastPrices[symbol];
  if (!last) {
    state.lastPrices[symbol] = price;
    return;
  }

  const change = (price - last) / last;

  state.volatility =
    state.volatility * 0.9 + Math.abs(change) * 0.1;

  state.acceleration =
    state.acceleration * 0.9 + change * 0.1;

  state.lastPrices[symbol] = price;
}

function classifyRegime(state) {
  const vol = state.volatility;
  const accel = Math.abs(state.acceleration);

  if (vol > 0.025) return "PANIC";
  if (vol > 0.01 && accel > 0.003) return "TRENDING";
  if (vol < 0.003) return "LOW_VOL";
  return "RANGING";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "TRENDING": return 1.2;
    case "RANGING": return 0.7;
    case "PANIC": return 0.3;
    case "LOW_VOL": return 1.0;
    default: return 1;
  }
}

/* ================= PORTFOLIO ================= */

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
  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

/* ================= POSITION ================= */

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

    state.cashBalance += pnl;
    state.trades.push({ symbol, pnl });

    updatePerformance(state, pnl);

    const signalKey =
      state.lastSignalKey || null;

    if (signalKey)
      updateSignalStats(state, signalKey, pnl);

    pos.qty = newQty;
    pos.avgEntry = price;
  }

  recalcPortfolio(state);
}

/* ================= TICK ================= */

async function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  refreshFlags(state);

  updateMarketMetrics(state, symbol, price);
  state.regime = classifyRegime(state);

  recalcPortfolio(state);

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

  const signalKey = buildSignalKey(
    symbol,
    state.regime,
    plan.action
  );

  state.lastSignalKey = signalKey;

  const regimeMult = regimeMultiplier(state.regime);
  const performanceMult = state.performance.score;

  const signalScore =
    state.signalIntelligence.stats[signalKey]?.score || 1;

  const finalRisk =
    plan.riskPct *
    regimeMult *
    performanceMult *
    signalScore;

  const positionValue =
    state.equity *
    clamp(finalRisk, 0.001, 0.05) *
    state.dynamicLeverage;

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
      regime: state.regime,
      perfScore: state.performance.score,
      signalScore,
      ok: result?.ok,
    });

    if (state.orders.length > MAX_ORDERS)
      state.orders = state.orders.slice(-MAX_ORDERS);

  } catch (err) {
    state.lastError = String(err?.message || err);
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
    fs.writeFileSync(statePath(tenantId), JSON.stringify(state, null, 2));
  } catch {}
}

function refreshFlags(state) {
  state.enabled = envTrue("LIVE_TRADING_ENABLED");
  state.execute = state.enabled && envTrue("LIVE_TRADING_EXECUTE");
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    equity: state.equity,
    regime: state.regime,
    performanceScore: state.performance.score,
    winRate: state.performance.winRate,
    signalIntelligence: state.signalIntelligence.stats,
    grossExposure: state.grossExposure,
    netExposure: state.netExposure,
    routerHealth: exchangeRouter.getHealth(),
  };
}

module.exports = {
  start: (id) => { const s = load(id); s.running = true; save(id); },
  stop: (id) => { const s = load(id); s.running = false; save(id); },
  tick,
  snapshot,
};
