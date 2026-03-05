// backend/src/services/marketRegimeDetector.js
// ==========================================================
// Market Regime Detector
// Detects: Bull Trend / Bear Trend / Sideways / Volatile
// Tenant Safe • Lightweight • AI Ready
// ==========================================================

const MAX_HISTORY = 200;

const REGIME_STATE = new Map();

/* ================= UTIL ================= */

function safeNum(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ================= TENANT STATE ================= */

function getState(tenantId) {

  const key = tenantId || "__default__";

  if (!REGIME_STATE.has(key)) {

    REGIME_STATE.set(key, {

      prices: [],
      lastPrice: null,

      regime: "unknown",
      volatility: 0,

      trendStrength: 0,

      lastUpdated: Date.now()

    });

  }

  return REGIME_STATE.get(key);

}

/* ================= VOLATILITY ================= */

function calcVolatility(prices) {

  if (prices.length < 10) return 0;

  let sum = 0;

  for (let i = 1; i < prices.length; i++) {

    const change =
      (prices[i] - prices[i - 1]) / prices[i - 1];

    sum += Math.abs(change);

  }

  return sum / prices.length;

}

/* ================= TREND ================= */

function calcTrend(prices) {

  if (prices.length < 20) {
    return { slope: 0, strength: 0 };
  }

  const first = prices[0];
  const last = prices[prices.length - 1];

  const slope =
    (last - first) / first;

  const strength = Math.abs(slope);

  return { slope, strength };

}

/* ================= REGIME ================= */

function detectRegime({ slope, strength, volatility }) {

  if (volatility > 0.015) {
    return "volatile";
  }

  if (slope > 0.01 && strength > 0.01) {
    return "bull";
  }

  if (slope < -0.01 && strength > 0.01) {
    return "bear";
  }

  return "sideways";

}

/* ================= UPDATE ================= */

function update({ tenantId, symbol, price }) {

  const state = getState(tenantId);

  const p = safeNum(price);

  if (!p || p <= 0) return state;

  state.lastPrice = p;

  state.prices.push(p);

  if (state.prices.length > MAX_HISTORY) {
    state.prices.shift();
  }

  const volatility =
    calcVolatility(state.prices);

  const trend =
    calcTrend(state.prices);

  const regime =
    detectRegime({
      slope: trend.slope,
      strength: trend.strength,
      volatility
    });

  state.regime = regime;
  state.volatility = volatility;
  state.trendStrength = trend.strength;

  state.lastUpdated = Date.now();

  return state;

}

/* ================= GET ================= */

function getRegime(tenantId) {

  const state =
    getState(tenantId);

  return {

    regime: state.regime,
    volatility: state.volatility,
    trendStrength: state.trendStrength,
    lastUpdated: state.lastUpdated

  };

}

/* ================= RESET ================= */

function reset(tenantId) {

  const key = tenantId || "__default__";

  REGIME_STATE.delete(key);

}

/* ================= EXPORT ================= */

module.exports = {

  update,
  getRegime,
  reset

};
