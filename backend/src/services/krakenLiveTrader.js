// backend/src/services/krakenLiveTrader.js
// Kraken LIVE Trader (Executor)
// - This is NOT the "brain". This is the "hands" that places real orders.
// - It expects a decision snapshot from YOUR existing logic (paperTrader/brain).
// - Same rules for paper & live: if decision says WAIT, we do NOTHING.
// - Includes safety gates + simple position tracking (in-memory).
//
// ENV REQUIRED (Render backend):
//   KRAKEN_API_KEY=...
//   KRAKEN_API_SECRET=...   (base64 string from Kraken)
// OPTIONAL SAFETY:
//   LIVE_TRADING_ENABLED=false   (default false; must be true to place orders)
//   LIVE_MAX_NOTIONAL_USD=25     (absolute cap per order)
//   LIVE_COOLDOWN_MS=30000       (min time between orders)

const crypto = require("crypto");

const KRAKEN_BASE = "https://api.kraken.com";
const API_KEY = String(process.env.KRAKEN_API_KEY || "").trim();
const API_SECRET = String(process.env.KRAKEN_API_SECRET || "").trim();

const LIVE_ENABLED = String(process.env.LIVE_TRADING_ENABLED || "false").trim().toLowerCase() === "true";
const LIVE_MAX_NOTIONAL_USD = Number(process.env.LIVE_MAX_NOTIONAL_USD || 25); // hard cap per order
const LIVE_COOLDOWN_MS = Number(process.env.LIVE_COOLDOWN_MS || 30_000);

function ok(v) {
  return v !== null && v !== undefined && v !== "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------- Kraken signing helpers --------
//
// Kraken private REST signing:
// API-Sign = base64(HMAC-SHA512(secret, urlpath + SHA256(nonce + POSTdata)))
function krakenSign(urlPath, bodyStr, nonce) {
  const secret = Buffer.from(API_SECRET, "base64");
  const hash = crypto.createHash("sha256").update(String(nonce) + bodyStr).digest();
  const hmac = crypto.createHmac("sha512", secret).update(Buffer.concat([Buffer.from(urlPath), hash])).digest("base64");
  return hmac;
}

async function krakenPrivate(urlPath, paramsObj) {
  if (!ok(API_KEY) || !ok(API_SECRET)) {
    throw new Error("Missing KRAKEN_API_KEY or KRAKEN_API_SECRET");
  }

  const nonce = Date.now();
  const body = new URLSearchParams({ nonce: String(nonce), ...(paramsObj || {}) });
  const bodyStr = body.toString();

  const res = await fetch(KRAKEN_BASE + urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key": API_KEY,
      "API-Sign": krakenSign(urlPath, bodyStr, nonce),
    },
    body: bodyStr,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Kraken HTTP ${res.status}: ${JSON.stringify(json || {})}`);
  }
  if (!json) throw new Error("Kraken: empty response");
  if (Array.isArray(json.error) && json.error.length) {
    throw new Error(`Kraken error: ${json.error.join(", ")}`);
  }
  return json.result;
}

async function krakenPublic(path) {
  const res = await fetch(KRAKEN_BASE + path);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Kraken public HTTP ${res.status}`);
  if (!json) throw new Error("Kraken public: empty response");
  if (Array.isArray(json.error) && json.error.length) {
    throw new Error(`Kraken public error: ${json.error.join(", ")}`);
  }
  return json.result;
}

// -------- Pair mapping --------
// Your app uses symbols like BTCUSDT / ETHUSDT sometimes.
// Kraken uses pairs like XBTUSD, ETHUSD, etc.
function toKrakenPair(symbol) {
  const s = String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (s === "BTCUSD" || s === "XBTUSD") return "XBTUSD";
  if (s === "ETHUSD") return "ETHUSD";

  // If your feed sends BTCUSDT, map it to XBTUSD for now (USDT isn’t always available on Kraken spot)
  if (s === "BTCUSDT") return "XBTUSD";
  if (s === "ETHUSDT") return "ETHUSD";

  // fallback: assume already Kraken-ish
  return s;
}

// -------- Simple live state --------
const state = {
  enabled: LIVE_ENABLED,
  lastOrderAt: 0,

  // track last known position (basic)
  position: null, // { pair, side, vol, avgPrice, openedAt }
  lastOrder: null,
  errors: [],
};

function pushErr(e) {
  const msg = String(e?.message || e || "error");
  state.errors.push({ ts: Date.now(), msg });
  if (state.errors.length > 50) state.errors = state.errors.slice(-50);
}

function getStatus() {
  return {
    ok: true,
    enabled: state.enabled,
    liveEnvEnabled: LIVE_ENABLED,
    cooldownMs: LIVE_COOLDOWN_MS,
    lastOrderAt: state.lastOrderAt || null,
    hasKeys: ok(API_KEY) && ok(API_SECRET),
    position: state.position,
    lastOrder: state.lastOrder,
    recentErrors: state.errors.slice(-10),
  };
}

function setEnabled(on) {
  state.enabled = !!on;
}

function clearPosition() {
  state.position = null;
}

// -------- Risk / sizing --------
// This executor purposely caps size hard. You can widen later.
function calcVolumeFromNotionalUSD(pair, notionalUSD, price) {
  // For spot: vol = notional / price (approx)
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0;

  const n = Number(notionalUSD);
  if (!Number.isFinite(n) || n <= 0) return 0;

  const vol = n / p;

  // Kraken volume must be a string with decimals; we’ll do 6dp by default
  return Math.max(0, vol);
}

// -------- Order placement --------
// type: "market" | "limit"
async function placeOrder({ symbol, side, price, notionalUSD, type = "market", limitPrice = null }) {
  const pair = toKrakenPair(symbol);

  const now = Date.now();
  if (!state.enabled) return { ok: false, skipped: true, reason: "live disabled (state)" };
  if (!LIVE_ENABLED) return { ok: false, skipped: true, reason: "LIVE_TRADING_ENABLED is false (env)" };

  if (now - state.lastOrderAt < LIVE_COOLDOWN_MS) {
    return { ok: false, skipped: true, reason: "cooldown" };
  }

  const useNotional = Math.min(Number(notionalUSD || 0), LIVE_MAX_NOTIONAL_USD);
  if (!(useNotional > 0)) return { ok: false, skipped: true, reason: "notional <= 0" };

  const vol = calcVolumeFromNotionalUSD(pair, useNotional, price);
  if (!(vol > 0)) return { ok: false, skipped: true, reason: "volume <= 0" };

  const orderType = String(type).toLowerCase() === "limit" ? "limit" : "market";
  const krSide = String(side).toLowerCase() === "sell" ? "sell" : "buy";

  const params = {
    pair,
    type: krSide,
    ordertype: orderType,
    volume: vol.toFixed(6),
  };

  if (orderType === "limit") {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) {
      return { ok: false, skipped: true, reason: "missing limitPrice" };
    }
    params.price = lp.toFixed(2);
  }

  const result = await krakenPrivate("/0/private/AddOrder", params);

  state.lastOrderAt = now;
  state.lastOrder = {
    ts: now,
    pair,
    side: krSide,
    orderType,
    volume: params.volume,
    notionalUSD: useNotional,
    txid: result?.txid?.[0] || null,
    descr: result?.descr || null,
  };

  // update simplistic “position” view (for now: assume order opens exposure)
  state.position = {
    pair,
    side: krSide,
    vol: Number(params.volume),
    avgPrice: Number(price) || null,
    openedAt: now,
  };

  return { ok: true, result: state.lastOrder };
}

// -------- Main entry: feed decision snapshot --------
//
// decisionSnapshot example (from your paper/brain):
// {
//   symbol: "BTCUSDT",
//   price: 65000,
//   decision: "BUY" | "SELL" | "WAIT",
//   confidence: 0.72,
//   trendEdge: 0.0031,
//   halted: false,
//   lossesToday: 0,
//   notionalUSD: 15,          // recommended size from your risk rules
//   orderType: "market",      // market|limit (optional)
//   limitPrice: 64950         // optional
// }
//
// IMPORTANT: This function does NOT invent signals.
// It only executes what YOUR brain decided.
async function evaluateAndTrade(snapshot) {
  try {
    const s = snapshot || {};
    const decision = String(s.decision || "WAIT").toUpperCase();
    const symbol = String(s.symbol || "").trim();
    const price = Number(s.price);

    if (!ok(symbol) || !Number.isFinite(price)) {
      return { ok: false, skipped: true, reason: "missing symbol/price" };
    }

    // Hard safety
    if (s.halted) return { ok: true, skipped: true, reason: "halted by safety" };

    // Only act on BUY/SELL
    if (decision !== "BUY" && decision !== "SELL") {
      return { ok: true, skipped: true, reason: "decision WAIT/UNKNOWN" };
    }

    // optional: if you pass "approved" from brain, require it
    if (s.approved === false) {
      return { ok: true, skipped: true, reason: "brain did not approve" };
    }

    // optional: do not flip instantly (basic)
    if (state.position && state.position.pair === toKrakenPair(symbol)) {
      // If we already have an open position, don’t keep spamming
      // Later we can add reduce/close logic.
      return { ok: true, skipped: true, reason: "position already open (basic lock)" };
    }

    const out = await placeOrder({
      symbol,
      side: decision,
      price,
      notionalUSD: Number(s.notionalUSD || 0),
      type: s.orderType || "market",
      limitPrice: s.limitPrice || null,
    });

    return out;
  } catch (e) {
    pushErr(e);
    return { ok: false, error: String(e?.message || e) };
  }
}

module.exports = {
  getStatus,
  setEnabled,
  clearPosition,
  evaluateAndTrade,
  placeOrder,
};
