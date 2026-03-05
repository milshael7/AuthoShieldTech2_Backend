// backend/src/services/exchangeRouter.js
// Phase 15 — Institutional Smart Execution Router
// Kraken First • Crash Safe • Dynamic Routing

const fs = require("fs");
const path = require("path");

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
    process.env.KRAKEN_API_KEY ||
    process.env.BINANCE_API_KEY ||
    process.env.COINBASE_API_KEY
  );
}

const CONFIG = Object.freeze({
  primary: process.env.EXECUTION_PRIMARY || "kraken",
  secondary: process.env.EXECUTION_SECONDARY || "binance",
  tertiary: process.env.EXECUTION_TERTIARY || "coinbase",

  failureThreshold: Number(process.env.EXECUTION_FAILURE_THRESHOLD || 3),
  cooldownMs: Number(process.env.EXECUTION_FAILURE_COOLDOWN || 60000),

  metricsWindow: Number(process.env.EXECUTION_METRICS_WINDOW || 50),

  executionTimeoutMs: Number(process.env.EXECUTION_TIMEOUT_MS || 8000),
});

/* =========================================================
SAFE ADAPTER LOADER
========================================================= */

function safeRequire(name) {

  try {

    const file = path.join(__dirname, "adapters", `${name}Adapter.js`);

    if (!fs.existsSync(file)) return null;

    return require(file);

  } catch {

    return null;

  }

}

const ADAPTERS = {
  kraken: () => safeRequire("kraken"),
  binance: () => safeRequire("binance"),
  coinbase: () => safeRequire("coinbase"),
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

function markFailure(name, err) {

  const state = getAdapterState(name);

  state.failures++;
  state.lastError = String(err?.message || err);

  if (state.failures >= CONFIG.failureThreshold) {
    state.cooldownUntil = Date.now() + CONFIG.cooldownMs;
  }

}

function markSuccess(name, latency) {

  const state = getAdapterState(name);

  state.failures = 0;
  state.cooldownUntil = 0;
  state.metrics.success++;

  if (Number.isFinite(latency)) {

    state.metrics.latencySamples.push(latency);

    if (state.metrics.latencySamples.length > CONFIG.metricsWindow) {
      state.metrics.latencySamples =
        state.metrics.latencySamples.slice(-CONFIG.metricsWindow);
    }

  }

}

function adapterAvailable(name) {
  return Date.now() >= getAdapterState(name).cooldownUntil;
}

function avgLatency(samples = []) {
  if (!samples.length) return 9999;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/* =========================================================
ROUTE ORDER
========================================================= */

function getRouteOrder() {

  const base = [
    CONFIG.primary,
    CONFIG.secondary,
    CONFIG.tertiary,
  ];

  return base.filter(Boolean);

}

/* =========================================================
TIMEOUT
========================================================= */

function withTimeout(promise, ms) {

  let timeout;

  const timeoutPromise = new Promise((_, reject) => {

    timeout = setTimeout(() => {
      reject(new Error("Execution timeout"));
    }, ms);

  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeout));

}

/* =========================================================
ROUTER
========================================================= */

async function routeLiveOrder(params = {}) {

  if (envTrue("EXECUTION_KILL_SWITCH")) {

    return {
      ok: false,
      error: "Execution blocked by kill switch",
    };

  }

  if (!hasApiKeys()) {

    return {
      ok: false,
      error: "No exchange API keys configured",
    };

  }

  const route = getRouteOrder();

  for (const exchange of route) {

    if (!adapterAvailable(exchange)) continue;

    const adapterFactory = ADAPTERS[exchange];

    if (!adapterFactory) continue;

    const adapter = adapterFactory();

    if (!adapter || typeof adapter.executeLiveOrder !== "function")
      continue;

    try {

      markAttempt(exchange);

      const start = Date.now();

      const result = await withTimeout(
        adapter.executeLiveOrder(params),
        CONFIG.executionTimeoutMs
      );

      const latency = Date.now() - start;

      markSuccess(exchange, latency);

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
    error: "All execution adapters failed",
  };

}

/* =========================================================
HEALTH
========================================================= */

function getHealth() {

  const out = { adapters: {} };

  for (const [name, state] of ADAPTER_STATE.entries()) {

    out.adapters[name] = {
      failures: state.failures,
      cooling: Date.now() < state.cooldownUntil,
      lastError: state.lastError,
      successRate:
        state.metrics.totalAttempts > 0
          ? state.metrics.success / state.metrics.totalAttempts
          : 1,
      avgLatencyMs: avgLatency(state.metrics.latencySamples),
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
