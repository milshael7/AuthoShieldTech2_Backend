// backend/src/services/adapters/krakenAdapter.js
// Phase 17 — Kraken Smart Institutional Adapter
// Router Compatible • Real Execution + Simulation

const kraken = require("../krakenConnector");

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({
  name: "kraken",

  // controlled by env if you ever want simulation again
  sandbox:
    String(process.env.KRAKEN_SANDBOX || "false")
      .toLowerCase() === "true",

  baseSlippagePct: 0.0007,
});

/* =========================================================
UTIL
========================================================= */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function buildOrderId() {
  return `kraken_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/* =========================================================
NORMALIZATION
========================================================= */

function normalizeParams(params = {}) {
  return {
    symbol: String(params.symbol || "BTCUSD").toUpperCase(),
    side: String(params.side || "").toUpperCase(),
    qty: safeNum(params.qty, 0),
    price: safeNum(params.price, 0),
    riskPct: safeNum(params.riskPct, 0),
    clientOrderId: params.clientOrderId || buildOrderId(),
  };
}

/* =========================================================
QTY DERIVATION
========================================================= */

function deriveQty(order) {

  if (order.qty > 0) return order.qty;

  if (order.riskPct > 0 && order.price > 0) {

    const notional = 10_000 * order.riskPct;

    return notional / order.price;

  }

  return 0;

}

/* =========================================================
EXECUTION
========================================================= */

async function executeLiveOrder(params = {}) {

  const order = normalizeParams(params);

  const qty = deriveQty(order);

  if (!order.symbol || !order.side || !qty) {

    return {
      ok: false,
      exchange: CONFIG.name,
      error: "Invalid order parameters",
    };

  }

  /* =====================================================
  SANDBOX MODE
  ===================================================== */

  if (CONFIG.sandbox) {

    return {
      ok: true,
      exchange: CONFIG.name,
      result: {
        symbol: order.symbol,
        side: order.side,
        qty,
        avgPrice: order.price,
        status: "SIMULATED_FILL",
        timestamp: nowIso(),
      },
    };

  }

  /* =====================================================
  REAL KRAKEN EXECUTION
  ===================================================== */

  try {

    const result = await kraken.executeLiveOrder({

      symbol: order.symbol,

      action: order.side,

      qty,

    });

    if (!result || !result.ok) {

      return {

        ok: false,

        exchange: CONFIG.name,

        error: "Kraken order failed",

      };

    }

    return {

      ok: true,

      exchange: CONFIG.name,

      result: result.order,

    };

  } catch (err) {

    return {

      ok: false,

      exchange: CONFIG.name,

      error: err?.message || "Execution error",

    };

  }

}

/* =========================================================
HEALTH
========================================================= */

function health() {

  return {

    ok: true,

    exchange: CONFIG.name,

    sandbox: CONFIG.sandbox,

    time: nowIso(),

  };

}

module.exports = {

  executeLiveOrder,

  health,

};
