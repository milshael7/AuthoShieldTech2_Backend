// backend/src/services/adapters/coinbaseAdapter.js
// Phase 10 — Coinbase Advanced Trade Adapter (Institutional Skeleton)
// Router compatible • HMAC signing scaffold • Sandbox safe

const crypto = require("crypto");

/* =========================================================
   CONFIG (ENV wired later)
========================================================= */

const CONFIG = Object.freeze({
  name: "coinbase",
  sandbox: true, // default safe mode
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

function buildOrderId() {
  return `coinbase_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/*
  Coinbase Advanced Trade signing format:
  signature = HMAC_SHA256(secret, timestamp + method + requestPath + body)
*/
function signRequest(secret, payload) {
  if (!secret) return null;

  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
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
    type: "MARKET",
    clientOrderId: params.clientOrderId || buildOrderId(),
  };
}

/* =========================================================
   EXECUTION
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

  /* =====================================================
     SANDBOX MODE (SAFE DEFAULT)
  ===================================================== */

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
    PRODUCTION FLOW (NOT ENABLED YET)
    -------------------------------------------------------
    1. Build request body
    2. Build signature string
    3. Sign with secret
    4. Send HTTPS request
    5. Normalize response
  */

  try {
    throw new Error("Live Coinbase execution not implemented.");
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
