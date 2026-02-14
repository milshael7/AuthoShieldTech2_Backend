// backend/src/services/adapters/krakenAdapter.js
// Phase 10 — Kraken Institutional Adapter
// Router compatible • HMAC signing scaffold • Sandbox safe
// Advanced trade-ready skeleton (REST v1 style signing model)

const crypto = require("crypto");

/* =========================================================
   CONFIG (ENV wired later)
========================================================= */

const CONFIG = Object.freeze({
  name: "kraken",
  sandbox: true, // safe by default
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
  return `kraken_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/*
  Kraken signing format (REST private endpoints):
  signature = HMAC_SHA512(secret, path + SHA256(nonce + postData))
*/
function signRequest(secret, path, nonce, body) {
  if (!secret) return null;

  const postData = new URLSearchParams(body).toString();
  const message = nonce + postData;

  const hash = crypto
    .createHash("sha256")
    .update(message)
    .digest();

  const hmac = crypto.createHmac(
    "sha512",
    Buffer.from(secret, "base64")
  );

  const signature = hmac
    .update(path + hash)
    .digest("base64");

  return signature;
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
    1. Build nonce
    2. Construct request body
    3. Create signature
    4. Send HTTPS POST to Kraken private endpoint
    5. Normalize response
  */

  try {
    throw new Error("Live Kraken execution not implemented.");
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
