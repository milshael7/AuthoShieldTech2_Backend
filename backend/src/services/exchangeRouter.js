// backend/src/services/exchangeRouter.js
// Phase 15 — Institutional Smart Execution Router
// Dynamic Ranking • Latency Scoring • Circuit Breaker
// Capital Lock Detection • Runtime Kill Switch
// Liquidation Weighted Routing • Telemetry Hardened

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

function envTrue(name) {
  const v = String(process.env[name] || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function hasApiKeys() {
  return (
    process.env.BINANCE_API_KEY ||
    process.env.COINBASE_API_KEY ||
    process.env.KRAKEN_API_KEY ||
    process.env.CRYPTO_API_KEY
  );
}

const CONFIG = Object.freeze({
  primary: process.env.EXECUTION_PRIMARY || "binance",
  secondary: process.env.EXECUTION_SECONDARY || "coinbase",
  tertiary: process.env.EXECUTION_TERTIARY || "kraken",

  failureThreshold: Number(process.env.EXECUTION_FAILURE_THRESHOLD || 3),
  cooldownMs: Number(process.env.EXECUTION_FAILURE_COOLDOWN || 60_000),

  metricsWindow: Number(process.env.EXECUTION_METRICS_WINDOW || 50),

  executionTimeoutMs: Number(process.env.EXECUTION_TIMEOUT_MS || 8000),

  liquidationLatencyWeight: 0.6,
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
        totalAttempts: 0,
        success: 0,
        latencySamples: [],
        partialFills: 0,
        timeouts: 0,
      },
    });
  }
  return ADAPTER_STATE.get(name);
}

/* =========================================================
   METRICS
========================================================= */

function markAttempt(name) {
  getAdapterState(name).metrics.totalAttempts++;
}

function markFailure(name, err, isTimeout = false) {
  const state = getAdapterState(name);

  state.failures++;
  state.lastError = String(err?.message || err || "unknown");

  if (isTimeout) state.metrics.timeouts++;

  if (state.failures >= CONFIG.failureThreshold) {
    state.cooldownUntil = Date.now() + CONFIG.cooldownMs;
  }
}

function markSuccess(name, latencyMs, result = {}) {
  const state = getAdapterState(name);

  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastError = null;
  state.metrics.success++;

  if (Number.isFinite(latencyMs)) {
    state.metrics.latencySamples.push(latencyMs);
    if (state.metrics.latencySamples.length > CONFIG.metricsWindow) {
      state.metrics.latencySamples =
        state.metrics.latencySamples.slice(-CONFIG.metricsWindow);
    }
  }

  const filled = result?.order?.filledQty;
  const requested = result?.order?.requestedQty;

  if (filled && requested && filled < requested) {
    state.metrics.partialFills++;
  }
}

function adapterAvailable(name) {
  return Date.now() >= getAdapterState(name).cooldownUntil;
}

function avgLatency(samples = []) {
  if (!samples.length) return 9999;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function scoreAdapter(name, { forceClose } = {}) {
  const state = getAdapterState(name);
  const { totalAttempts, success, latencySamples } = state.metrics;

  const successRate =
    totalAttempts > 0 ? success / totalAttempts : 1;

  const latencyScore =
    1 / clamp(avgLatency(latencySamples), 1, 10000);

  if (forceClose) {
    return (
      successRate * (1 - CONFIG.liquidationLatencyWeight) +
      latencyScore * CONFIG.liquidationLatencyWeight
    );
  }

  return successRate * 0.7 + latencyScore * 0.3;
}

/* =========================================================
   ROUTE ORDER
========================================================= */

function getRouteOrder(context = {}) {
  const base = [
    CONFIG.primary,
    CONFIG.secondary,
    CONFIG.tertiary,
  ].filter(Boolean);

  return base
    .filter((name) => ADAPTERS[name])
    .sort(
      (a, b) => scoreAdapter(b, context) - scoreAdapter(a, context)
    );
}

/* =========================================================
   TIMEOUT WRAPPER
========================================================= */

function withTimeout(promise, ms) {
  let timeout;

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Execution timeout")),
      ms
    );
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeout));
}

/* =========================================================
   CORE ROUTER
========================================================= */

async function routeLiveOrder(params = {}) {

  // 🔥 Runtime Kill Switch
  if (envTrue("EXECUTION_KILL_SWITCH")) {
    return {
      ok: false,
      error: "Execution blocked by EXECUTION_KILL_SWITCH",
    };
  }

  // 🔒 API Key Guard
  if (!hasApiKeys()) {
    return {
      ok: false,
      error: "No exchange API keys configured.",
    };
  }

  const { forceClose } = params;
  const route = getRouteOrder({ forceClose });

  for (const exchange of route) {

    if (!adapterAvailable(exchange)) continue;

    const adapterFactory = ADAPTERS[exchange];
    if (!adapterFactory) continue;

    try {
      const adapter = adapterFactory();
      if (typeof adapter.executeLiveOrder !== "function") continue;

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
      const isTimeout =
        String(err?.message || "")
          .toLowerCase()
          .includes("timeout");

      markFailure(exchange, err, isTimeout);
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
  const out = {
    adapters: {},
  };

  for (const [name, state] of ADAPTER_STATE.entries()) {
    const { metrics } = state;

    out.adapters[name] = {
      failures: state.failures,
      cooling: Date.now() < state.cooldownUntil,
      lastError: state.lastError,
      successRate:
        metrics.totalAttempts > 0
          ? metrics.success / metrics.totalAttempts
          : 1,
      avgLatencyMs: avgLatency(metrics.latencySamples),
      partialFills: metrics.partialFills,
      timeouts: metrics.timeouts,
    };
  }

  return out;
}

function reset() {
  ADAPTER_STATE.clear();
}

module.exports = {
  routeLiveOrder,
  getHealth,
  reset,
};
