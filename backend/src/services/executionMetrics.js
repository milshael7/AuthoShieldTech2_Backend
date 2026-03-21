// ==========================================================
// FILE: backend/src/services/executionMetrics.js
// VERSION: v2 — Realistic Execution Intelligence Layer
//
// UPGRADES:
// ✔ Simulated slippage (realistic fills)
// ✔ Latency tracking
// ✔ Execution feedback loop
// ✔ Exchange scoring ready for routing engine
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
    });
  }

  return EXCHANGE_STATS.get(name);
}

/* =========================================================
SIMULATION HELPERS
These make paper trading feel REAL
========================================================= */

function simulateLatency() {
  // 20ms → 250ms realistic range
  return Math.floor(20 + Math.random() * 230);
}

function simulateSlippage(price, side) {
  // 0% → 0.08% slippage
  const slipPct = Math.random() * 0.0008;

  if (side === "BUY") {
    return price * (1 + slipPct);
  }

  if (side === "SELL") {
    return price * (1 - slipPct);
  }

  return price;
}

/* =========================================================
EXECUTE (NEW CORE FUNCTION)
This should be used by executionEngine
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

  const score =
    successRate * 0.6 +
    (1 - clamp(avgLatency / 2000, 0, 1)) * 0.25 +
    (1 - clamp(avgSlippage / 0.01, 0, 1)) * 0.15;

  return {
    executions: state.executions,
    successRate,
    avgLatency,
    avgSlippage,
    score: clamp(score, 0, 1),
  };
}

/* =========================================================
RANKING
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
  executeWithMetrics, // ⭐ NEW CORE
  getMetrics,
  rankExchanges,
  getAllMetrics,
  reset,
};
