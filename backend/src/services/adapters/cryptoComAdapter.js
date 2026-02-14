// backend/src/services/adapters/cryptoAdapter.js
// Phase 10 — Crypto.com Adapter (Institutional Skeleton)
// Production-ready structure • Safe by default • Router compatible

const crypto = require("crypto");

/* =========================================================
   CONFIG (ENV will be added later in final batch)
========================================================= */

const CONFIG = Object.freeze({
  name: "crypto",
  sandbox: true, // default safe mode
});

/* =========================================================
   INTERNAL HELPERS
========================================================= */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function buildOrderId() {
  return `crypto_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/*
  Future:
  signRequest(apiKey, secret, payload)
*/
function signPayload(secret, payload) {
  if (!secret) return null;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return hmac.digest("hex");
}

/* =========================================================
   NORMALIZATION LAYER
========================================================= */

function normalizeParams(params = {}) {
  return {
    symbol: String(params.symbol || "").toUpperCase(),
    side: String(params.side || "").toUpperCase(),
    qty: safeNum(params.qty, 0),
    price: safeNum(params.price, 0),
    riskPct: safeNum(params.riskPct, 0),
    clientOrderId: params.clientOrderId || buildOrderId(),
  };
}

/* =========================================================
   CORE EXECUTION
========================================================= */

async function executeLiveOrder(params = {}) {
  const startedAt = Date.now();

  const order = normalizeParams(params);

  if (!order.symbol || !order.side || !order.qty) {
    return {
      ok: false,
      exchange: CONFIG.name,
      error: "Invalid order parameters",
    };
  }

  /*
    SAFE MODE:
    No real HTTP call yet.
    This is structured for future REST integration.
  */

  if (CONFIG.sandbox) {
    return buildResponse({
      order,
      status: "SIMULATED",
      filledQty: order.qty,
      avgPrice: order.price,
      latencyMs: Date.now() - startedAt,
    });
  }

  /*
    PRODUCTION FLOW (placeholder)
    -------------------------------------------------------
    1. Build request payload
    2. Sign with secret
    3. Send HTTPS request
    4. Normalize exchange response
  */

  try {
    // placeholder
    throw new Error("Live execution not implemented yet.");
  } catch (err) {
    return {
      ok: false,
      exchange: CONFIG.name,
      error: err.message || "Execution failure",
    };
  }
}

/* =========================================================
   RESPONSE BUILDER
========================================================= */

function buildResponse({
  order,
  status,
  filledQty,
  avgPrice,
  latencyMs,
}) {
  return {
    ok: true,
    exchange: CONFIG.name,

    order: {
      symbol: order.symbol,
      side: order.side,
      requestedQty: order.qty,
      filledQty,
      avgPrice,
      status,
      clientOrderId: order.clientOrderId,
    },

    metrics: {
      latencyMs,
      timestamp: nowIso(),
    },
  };
}

/* =========================================================
   HEALTH CHECK
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
