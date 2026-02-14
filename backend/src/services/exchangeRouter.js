// backend/src/services/exchangeRouter.js
// Phase 15 — Liquidation-Aware Institutional Smart Router
// Dynamic Ranking • Latency Scoring • Circuit Breaker
// Liquidation Priority Routing • Timeout Protection
// Adapter-Agnostic • Production Hardened

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  primary: process.env.EXECUTION_PRIMARY || "binance",
  secondary: process.env.EXECUTION_SECONDARY || "coinbase",
  tertiary: process.env.EXECUTION_TERTIARY || "kraken",

  failureThreshold: Number(process.env.EXECUTION_FAILURE_THRESHOLD || 3),
  cooldownMs: Number(process.env.EXECUTION_FAILURE_COOLDOWN || 60_000),

  metricsWindow: Number(process.env.EXECUTION_METRICS_WINDOW || 50),

  executionTimeoutMs: Number(process.env.EXECUTION_TIMEOUT_MS || 8000),

  liquidationLatencyWeight: 0.6, // prioritizes speed in liquidation
});

/* =========================================================
   ADAPTER REGISTRY
========================================================= */

const ADAPTERS = {
  binance: () => require("./adapters/binanceAdapter"),
  coinbase: () => require("./adapters/coinbaseAdapter"),
  kraken: () => require("./adapters/krakenAdapter"),
  crypto: () => require("./adapters/cryptoAdapter"),
};

/* =========================================================
   STATE
========================================================= */

const ADAPTER_STATE = new Map();

function getAdapterState(name) {
  if (!ADAPTER_STATE.has(name)) {
    ADAPTER_STATE.set(name, {
      failures: 0,
      cooldownUntil: 0,
      lastError: null,

      metrics: {
        total: 0,
        success: 0,
        latencySamples: [],
        partialFills: 0,
      },
    });
  }
  return ADAPTER_STATE.get(name);
}

/* =========================================================
   HEALTH + METRICS
========================================================= */

function markFailure(name, err) {
  const state = getAdapterState(name);
  state.failures++;
  state.lastError = String(err?.message || err || "unknown");

  if (state.failures >= CONFIG.failureThreshold) {
    state.cooldownUntil = Date.now() + CONFIG.cooldownMs;
  }
}

function markSuccess(name, latencyMs, result = {}) {
  const state = getAdapterState(name);

  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastError = null;

  state.metrics.total++;
  state.metrics.success++;

  if (Number.isFinite(latencyMs)) {
    state.metrics.latencySamples.push(latencyMs);
    if (state.metrics.latencySamples.length > CONFIG.metricsWindow) {
      state.metrics.latencySamples =
        state.metrics.latencySamples.slice(-CONFIG.metricsWindow);
    }
  }

  if (result?.filledQty && result?.requestedQty) {
    if (result.filledQty < result.requestedQty) {
      state.metrics.partialFills++;
    }
  }
}

function markAttempt(name) {
  const state = getAdapterState(name);
  state.metrics.total++;
}

function adapterAvailable(name) {
  const state = getAdapterState(name);
  return Date.now() >= state.cooldownUntil;
}

function avgLatency(samples = []) {
  if (!samples.length) return 9999;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function scoreAdapter(name, { forceClose } = {}) {
  const state = getAdapterState(name);
  const { total, success, latencySamples } = state.metrics;

  const successRate = total > 0 ? success / total : 1;
  const latencyScore = 1 / clamp(avgLatency(latencySamples), 1, 10_000);

  if (forceClose) {
    // During liquidation: prioritize speed more heavily
    return successRate * (1 - CONFIG.liquidationLatencyWeight) +
           latencyScore * CONFIG.liquidationLatencyWeight;
  }

  return successRate * 0.7 + latencyScore * 0.3;
}

/* =========================================================
   ROUTE ORDER (DYNAMIC RANKING)
========================================================= */

function getRouteOrder(context = {}) {
  const base = [
    CONFIG.primary,
    CONFIG.secondary,
    CONFIG.tertiary,
  ].filter(Boolean);

  return base
    .filter((name) => ADAPTERS[name])
    .sort((a, b) =>
      scoreAdapter(b, context) - scoreAdapter(a, context)
    );
}

/* =========================================================
   TIMEOUT WRAPPER
========================================================= */

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Execution timeout")), ms)
    ),
  ]);
}

/* =========================================================
   CORE ROUTER
========================================================= */

async function routeLiveOrder(params = {}) {
  const { forceClose } = params;

  const route = getRouteOrder({ forceClose });

  for (const exchange of route) {
    if (!adapterAvailable(exchange)) continue;

    const adapterFactory = ADAPTERS[exchange];
    if (!adapterFactory) continue;

    try {
      const adapter = adapterFactory();

      if (typeof adapter.executeLiveOrder !== "function") {
        continue;
      }

      markAttempt(exchange);

      const start = Date.now();

      const result = await withTimeout(
        adapter.executeLiveOrder(params),
        CONFIG.executionTimeoutMs
      );

      const latency = Date.now() - start;

      markSuccess(exchange, latency, result);

      return {
        ok: true,
        exchange,
        latencyMs: latency,
        result,
      };
    } catch (err) {
      markFailure(exchange, err);
    }
  }

  return {
    ok: false,
    error: "All execution adapters failed or cooling down.",
  };
}

/* =========================================================
   HEALTH SNAPSHOT
========================================================= */

function getHealth() {
  const out = {};

  for (const [name, state] of ADAPTER_STATE.entries()) {
    const { metrics } = state;

    out[name] = {
      failures: state.failures,
      cooling: Date.now() < state.cooldownUntil,
      lastError: state.lastError,
      successRate:
        metrics.total > 0
          ? metrics.success / metrics.total
          : 1,
      avgLatencyMs: avgLatency(metrics.latencySamples),
      partialFills: metrics.partialFills,
    };
  }

  return out;
}

/* =========================================================
   RESET
========================================================= */

function reset() {
  ADAPTER_STATE.clear();
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  routeLiveOrder,
  getHealth,
  reset,
};
