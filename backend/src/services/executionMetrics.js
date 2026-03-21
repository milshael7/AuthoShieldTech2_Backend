// ==========================================================
// FILE: backend/src/services/executionMetrics.js
// VERSION: v3.0 (Institutional Execution Intelligence Layer)
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const EXCHANGE_STATS = new Map();

const MAX_HISTORY = 500;

/* =========================================================
STATE
========================================================= */

function getState(name) {
  if (!EXCHANGE_STATS.has(name)) {
    EXCHANGE_STATS.set(name, {
      executions: 0,
      successes: 0,
      failures: 0,
      totalLatency: 0,
      totalSlippage: 0,
      history: [],
      lastQualityScore: 1,
    });
  }

  return EXCHANGE_STATS.get(name);
}

/* =========================================================
SIMULATION (REALISM)
========================================================= */

function simulateLatency() {
  return Math.floor(20 + Math.random() * 230);
}

function simulateSlippage(price, side) {
  const slipPct = Math.random() * 0.001; // slightly higher realism

  if (side === "BUY") return price * (1 + slipPct);
  if (side === "SELL") return price * (1 - slipPct);

  return price;
}

/* =========================================================
EXECUTION CORE
========================================================= */

function executeWithMetrics({
  exchange = "paper",
  side,
  price,
}) {
  const latencyMs = simulateLatency();

  const executedPrice = simulateSlippage(price, side);

  const slippagePct =
    price > 0 ? (executedPrice - price) / price : 0;

  recordExecution({
    exchange,
    ok: true,
    latencyMs,
    slippagePct,
  });

  return {
    executedPrice,
    latencyMs,
    slippagePct,
  };
}

/* =========================================================
RECORD EXECUTION
========================================================= */

function recordExecution({
  exchange,
  ok,
  latencyMs = 0,
  slippagePct = 0,
}) {
  if (!exchange) return;

  const state = getState(exchange);

  state.executions++;
  state.totalLatency += latencyMs;
  state.totalSlippage += Math.abs(slippagePct);

  if (ok) state.successes++;
  else state.failures++;

  state.history.push({
    ts: Date.now(),
    ok,
    latencyMs,
    slippagePct,
  });

  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

  // update quality score live
  state.lastQualityScore = computeExecutionQuality(state);
}

/* =========================================================
QUALITY ENGINE (NEW)
========================================================= */

function computeExecutionQuality(state) {
  if (!state || state.executions === 0) return 1;

  const successRate = state.successes / state.executions;

  const avgLatency = state.totalLatency / state.executions;
  const avgSlippage = state.totalSlippage / state.executions;

  // latency penalty (non-linear)
  const latencyScore = 1 - clamp(avgLatency / 1500, 0, 1);

  // slippage penalty (very sensitive)
  const slippageScore = 1 - clamp(avgSlippage / 0.008, 0, 1);

  const score =
    successRate * 0.5 +
    latencyScore * 0.25 +
    slippageScore * 0.25;

  return clamp(score, 0, 1);
}

/* =========================================================
MARKET CONDITION SIGNAL (NEW)
========================================================= */

function getExecutionCondition(exchange) {
  const state = getState(exchange);

  if (state.executions < 5) {
    return {
      condition: "unknown",
      quality: 1,
      riskMultiplier: 1,
    };
  }

  const quality = computeExecutionQuality(state);

  if (quality > 0.85) {
    return {
      condition: "excellent",
      quality,
      riskMultiplier: 1.1,
    };
  }

  if (quality > 0.7) {
    return {
      condition: "good",
      quality,
      riskMultiplier: 1,
    };
  }

  if (quality > 0.5) {
    return {
      condition: "degraded",
      quality,
      riskMultiplier: 0.8,
    };
  }

  return {
    condition: "poor",
    quality,
    riskMultiplier: 0.6,
  };
}

/* =========================================================
METRICS
========================================================= */

function getMetrics(exchange) {
  const state = getState(exchange);

  const successRate =
    state.executions > 0
      ? state.successes / state.executions
      : 1;

  const avgLatency =
    state.executions > 0
      ? state.totalLatency / state.executions
      : 0;

  const avgSlippage =
    state.executions > 0
      ? state.totalSlippage / state.executions
      : 0;

  const score = computeExecutionQuality(state);

  return {
    executions: state.executions,
    successRate,
    avgLatency,
    avgSlippage,
    score,
    condition: getExecutionCondition(exchange),
  };
}

/* =========================================================
RANKING (SMART ROUTING READY)
========================================================= */

function rankExchanges(list = []) {
  return list
    .map(name => ({
      name,
      ...getMetrics(name),
    }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.name);
}

function getBestExchange(list = []) {
  const ranked = rankExchanges(list);
  return ranked.length ? ranked[0] : null;
}

function getAllMetrics() {
  const out = {};

  for (const name of EXCHANGE_STATS.keys()) {
    out[name] = getMetrics(name);
  }

  return out;
}

function reset() {
  EXCHANGE_STATS.clear();
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  recordExecution,
  executeWithMetrics,
  getMetrics,
  getExecutionCondition, // ⭐ NEW
  getBestExchange,       // ⭐ NEW
  rankExchanges,
  getAllMetrics,
  reset,
};
