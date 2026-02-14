// backend/src/services/adapters/cryptoAdapter.js
// Phase 16 — Crypto.com Smart Adapter
// Router Compatible • Liquidation Aware • Risk-Based Qty
// Partial Fills • Slippage Model • Sandbox Safe

const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  name: "crypto",
  sandbox: true,

  baseSlippagePct: 0.0007,
  liquidationSlippagePct: 0.0018,

  partialFillProbability: 0.3,
  minPartialFillPct: 0.35,

  simulatedLatencyMin: 25,
  simulatedLatencyMax: 75,
});

/* =========================================================
   HELPERS
========================================================= */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function simulateLatency() {
  return randomBetween(
    CONFIG.simulatedLatencyMin,
    CONFIG.simulatedLatencyMax
  );
}

function simulateSlippage(price, side, forceClose) {
  const slip = forceClose
    ? CONFIG.liquidationSlippagePct
    : CONFIG.baseSlippagePct;

  if (side === "BUY") return price * (1 + slip);
  return price * (1 - slip);
}

function simulatePartialFill(qty, forceClose) {
  if (forceClose) return qty;

  if (Math.random() > CONFIG.partialFillProbability)
    return qty;

  const pct = randomBetween(CONFIG.minPartialFillPct, 0.95);
  return qty * pct;
}

function buildOrderId() {
  return `crypto_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/* =========================================================
   PARAM NORMALIZATION
========================================================= */

function normalizeParams(params = {}) {
  return {
    symbol: String(params.symbol || "").toUpperCase(),
    side: String(params.side || "").toUpperCase(),
    qty: safeNum(params.qty, 0),
    price: safeNum(params.price, 0),
    riskPct: safeNum(params.riskPct, 0),
    forceClose: !!params.forceClose,
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
  const startedAt = Date.now();
  const order = normalizeParams(params);

  const requestedQty = deriveQty(order);

  if (!order.symbol || !order.side || !requestedQty) {
    return {
      ok: false,
      exchange: CONFIG.name,
      error: "Invalid order parameters",
    };
  }

  /* =====================================================
     SANDBOX EXECUTION
  ===================================================== */

  if (CONFIG.sandbox) {
    const latency = simulateLatency();

    const slippedPrice = simulateSlippage(
      order.price,
      order.side,
      order.forceClose
    );

    const filledQty = simulatePartialFill(
      requestedQty,
      order.forceClose
    );

    return {
      ok: true,
      exchange: CONFIG.name,
      latencyMs: latency,

      result: {
        symbol: order.symbol,
        side: order.side,
        requestedQty,
        filledQty,
        avgPrice: slippedPrice,
        status: order.forceClose
          ? "LIQUIDATION_FILL"
          : "SIMULATED_FILL",
        clientOrderId: order.clientOrderId,
        timestamp: nowIso(),
      },
    };
  }

  /* =====================================================
     PRODUCTION FLOW (future wiring)
  ===================================================== */

  try {
    throw new Error("Live Crypto.com execution not implemented.");
  } catch (err) {
    return {
      ok: false,
      exchange: CONFIG.name,
      error: err.message || "Execution failure",
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

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  executeLiveOrder,
  health,
};
