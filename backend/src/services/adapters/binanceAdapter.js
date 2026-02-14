// backend/src/services/adapters/binanceAdapter.js
// Phase 10 — Binance Execution Adapter
// Live REST integration ready
// Safe by default • Dry-run capable • Signed request support scaffolded

const crypto = require("crypto");
const fetch = require("node-fetch");

const BINANCE_BASE =
  process.env.BINANCE_BASE_URL || "https://api.binance.com";

const API_KEY = process.env.BINANCE_API_KEY || null;
const API_SECRET = process.env.BINANCE_API_SECRET || null;

const DRY_RUN =
  String(process.env.EXECUTION_DRY_RUN || "true")
    .toLowerCase()
    .trim() !== "false";

/* =========================================================
   HELPERS
========================================================= */

function requireKeys() {
  if (!API_KEY || !API_SECRET) {
    throw new Error("Binance API keys missing.");
  }
}

function sign(query) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(query)
    .digest("hex");
}

function buildQuery(params = {}) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/* =========================================================
   EXECUTE LIVE ORDER
========================================================= */

async function executeLiveOrder(params = {}) {
  const {
    symbol,
    side,
    riskPct,
    equity,
  } = params;

  if (!symbol || !side) {
    throw new Error("Missing symbol or side.");
  }

  if (DRY_RUN) {
    return {
      mode: "dry-run",
      exchange: "binance",
      symbol,
      side,
      simulated: true,
      ts: Date.now(),
    };
  }

  requireKeys();

  if (!Number.isFinite(equity) || !Number.isFinite(riskPct)) {
    throw new Error("Invalid equity or riskPct.");
  }

  const notional = equity * riskPct;

  if (notional <= 0) {
    throw new Error("Notional too small.");
  }

  const quantity = notional; 
  // NOTE:
  // In production, you MUST convert notional to lot-size-adjusted quantity.
  // This is intentionally simplified scaffold logic.

  const timestamp = Date.now();

  const orderParams = {
    symbol,
    side,
    type: "MARKET",
    quantity,
    timestamp,
  };

  const query = buildQuery(orderParams);
  const signature = sign(query);

  const finalQuery = `${query}&signature=${signature}`;

  const response = await fetch(
    `${BINANCE_BASE}/api/v3/order`,
    {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: finalQuery,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Binance error: ${text}`);
  }

  const data = await response.json();

  return {
    mode: "live",
    exchange: "binance",
    symbol,
    side,
    orderId: data.orderId,
    status: data.status,
    raw: data,
    ts: Date.now(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  executeLiveOrder,
};
