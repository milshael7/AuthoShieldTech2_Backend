// backend/src/services/exchangeRouter.js
// Phase 10 — Institutional Exchange Router
// Multi-Exchange Execution Routing Layer
// Failover Ready • Circuit Breaker Protected • Adapter-Agnostic

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
});

/* =========================================================
   ADAPTER REGISTRY
   (Adapters will be required lazily to prevent crash if missing)
========================================================= */

const ADAPTERS = {
  binance: () => require("./binanceAdapter"),
  coinbase: () => require("./coinbaseAdapter"),
  kraken: () => require("./krakenAdapter"),
};

/* =========================================================
   ADAPTER HEALTH STATE
========================================================= */

const ADAPTER_STATE = new Map();

function getAdapterState(name) {
  if (!ADAPTER_STATE.has(name)) {
    ADAPTER_STATE.set(name, {
      failures: 0,
      cooldownUntil: 0,
      lastError: null,
    });
  }
  return ADAPTER_STATE.get(name);
}

function markFailure(name, err) {
  const state = getAdapterState(name);
  state.failures++;
  state.lastError = String(err?.message || err || "unknown");

  if (state.failures >= CONFIG.failureThreshold) {
    state.cooldownUntil = Date.now() + CONFIG.cooldownMs;
  }
}

function markSuccess(name) {
  const state = getAdapterState(name);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastError = null;
}

function adapterAvailable(name) {
  const state = getAdapterState(name);
  return Date.now() >= state.cooldownUntil;
}

/* =========================================================
   ROUTING ORDER
========================================================= */

function getRouteOrder() {
  return [
    CONFIG.primary,
    CONFIG.secondary,
    CONFIG.tertiary,
  ].filter(Boolean);
}

/* =========================================================
   CORE ROUTER
========================================================= */

async function routeLiveOrder(params = {}) {
  const route = getRouteOrder();

  for (const exchange of route) {
    if (!ADAPTERS[exchange]) continue;
    if (!adapterAvailable(exchange)) continue;

    try {
      const adapter = ADAPTERS[exchange]();
      if (typeof adapter.executeLiveOrder !== "function") {
        continue;
      }

      const result = await adapter.executeLiveOrder(params);

      markSuccess(exchange);

      return {
        ok: true,
        exchange,
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
    out[name] = {
      failures: state.failures,
      cooling: Date.now() < state.cooldownUntil,
      lastError: state.lastError,
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
