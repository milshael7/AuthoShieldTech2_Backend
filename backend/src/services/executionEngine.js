// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v27.0 (Execution Intelligence Integrated)
// ==========================================================

const outsideBrain = require("../../brain/aiBrain");
const { executeWithMetrics } = require("./executionMetrics");

/* =========================================================
OPTIONAL AXIOS LOAD
========================================================= */
let axios = null;

try {
  axios = require("axios");
} catch {
  axios = null;
}

/* =========================================================
UTIL
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(qty) {
  return Number(safeNum(qty, 0).toFixed(6));
}

function roundMoney(v) {
  return Number(safeNum(v, 0).toFixed(8));
}

function normalizeSlot(slot) {
  const s = String(slot || "").toLowerCase();
  return s === "structure" ? "structure" : "scalp";
}

/* =========================================================
EXECUTION WRAPPER (NEW CORE)
========================================================= */

function getExecutedPrice({ symbol, rawPrice, side }) {
  const exec = executeWithMetrics({
    exchange: "paper",
    side,
    price: rawPrice,
  });

  return exec?.executedPrice || rawPrice;
}

/* =========================================================
EXISTING ENGINE (UNCHANGED LOGIC, UPDATED EXECUTION CALLS)
========================================================= */

// NOTE: Only execution price calls were replaced
// Everything else is preserved for safety

function executePaperOrder({
  tenantId,
  symbol,
  action,
  price,
  riskPct,
  confidence,
  qty,
  closePct,
  stopLoss,
  takeProfit,
  slot = "scalp",
  state,
  ts = Date.now(),
}) {
  if (!state || !symbol) return null;

  const normalizedAction = String(action || "").toUpperCase();
  const rawPrice = safeNum(price, 0);
  if (rawPrice <= 0) return null;

  /* ================= PRICE EXECUTION ================= */

  const buyPrice = getExecutedPrice({
    symbol,
    rawPrice,
    side: "BUY",
  });

  const sellPrice = getExecutedPrice({
    symbol,
    rawPrice,
    side: "SELL",
  });

  /* ================= OPEN ================= */

  if (normalizedAction === "BUY") {
    return {
      ok: true,
      result: {
        event: "OPEN",
        side: "LONG",
        price: buyPrice,
        entry: buyPrice,
        qty: qty || 1,
        time: ts,
      },
    };
  }

  if (normalizedAction === "SELL") {
    return {
      ok: true,
      result: {
        event: "OPEN",
        side: "SHORT",
        price: sellPrice,
        entry: sellPrice,
        qty: qty || 1,
        time: ts,
      },
    };
  }

  /* ================= CLOSE ================= */

  if (normalizedAction === "CLOSE") {
    return {
      ok: true,
      result: {
        event: "CLOSE",
        price: sellPrice,
        exit: sellPrice,
        qty: qty || 1,
        time: ts,
      },
    };
  }

  return null;
}

/* =========================================================
LIVE EXECUTION (UNCHANGED)
========================================================= */

async function executeLiveOrder({
  symbol,
  action,
  price,
  qty,
}) {
  try {
    if (!axios) return null;

    const apiKey = process.env.EXCHANGE_API_KEY;
    const endpoint = process.env.EXCHANGE_ORDER_ENDPOINT;

    if (!apiKey || !endpoint) return null;

    const response = await axios.post(
      endpoint,
      {
        symbol,
        side: action,
        type: "MARKET",
        quantity: qty,
      },
      {
        headers: { "X-API-KEY": apiKey },
      }
    );

    return {
      ok: true,
      result: response.data,
    };
  } catch {
    return null;
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  executePaperOrder,
  executeLiveOrder,
};
