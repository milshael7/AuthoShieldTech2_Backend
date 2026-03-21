// ==========================================================
// FILE: backend/src/services/strategyEngine.js
// VERSION: v19.0 (Institutional Alignment + Timing Intelligence)
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* ================= CONFIG ================= */

const BASE_RISK = 0.01;
const MIN_CONFIDENCE = 0.45;
const MIN_EDGE = 0.0012;

/* ================= STATE ================= */

const MEMORY = new Map();

/* ================= UTILS ================= */

const safe = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

/* ================= PRICE MEMORY ================= */

function updateMemory(id, price) {
  const key = String(id || "__default__");

  if (!MEMORY.has(key)) {
    MEMORY.set(key, []);
  }

  const arr = MEMORY.get(key);

  arr.push(price);
  if (arr.length > 200) arr.shift();

  return arr;
}

/* ================= TREND ================= */

function getTrend(prices) {
  if (prices.length < 20) return "NEUTRAL";

  const start = prices[prices.length - 20];
  const end = prices[prices.length - 1];

  const move = (end - start) / start;

  if (Math.abs(move) < 0.002) return "CHOP";
  if (move > 0) return "UP";
  if (move < 0) return "DOWN";

  return "NEUTRAL";
}

/* ================= MOMENTUM ================= */

function getMomentum(prices) {
  if (prices.length < 5) return 0;

  const a = prices[prices.length - 5];
  const b = prices[prices.length - 1];

  return (b - a) / a;
}

/* ================= RANGE ================= */

function getRange(prices) {
  const slice = prices.slice(-30);

  const high = Math.max(...slice);
  const low = Math.min(...slice);
  const last = slice[slice.length - 1];

  return {
    high,
    low,
    mid: (high + low) / 2,
    nearHigh: (high - last) / last < 0.002,
    nearLow: (last - low) / last < 0.002,
  };
}

/* ================= ALIGNMENT SCORE ================= */

function getAlignmentScore({ trend, momentum, range }) {
  let score = 0;

  if (trend === "UP" && momentum > 0) score += 0.4;
  if (trend === "DOWN" && momentum < 0) score += 0.4;

  if (range.nearLow && momentum > 0) score += 0.3;
  if (range.nearHigh && momentum < 0) score += 0.3;

  return clamp(score, 0, 1);
}

/* ================= TIMING ================= */

function estimateMoveTime({ volatility, alignment }) {
  let base = 120000;

  base *= 1 + volatility * 2;
  base *= 1 + (1 - alignment);

  return clamp(base, 30000, 600000);
}

/* ================= LEVELS ================= */

function buildLevels(action, price, range) {
  const buffer = price * 0.002;

  if (action === "BUY") {
    const stop = range.low - buffer;
    const risk = price - stop;

    return {
      stopLoss: stop,
      takeProfit: price + risk * 1.8,
    };
  }

  if (action === "SELL") {
    const stop = range.high + buffer;
    const risk = stop - price;

    return {
      stopLoss: stop,
      takeProfit: price - risk * 1.8,
    };
  }

  return { stopLoss: null, takeProfit: null };
}

/* ================= CORE ================= */

function buildDecision(ctx = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    price,
    volatility = 0,
  } = ctx;

  const px = safe(price, NaN);
  if (!Number.isFinite(px)) {
    return { action: "WAIT", confidence: 0 };
  }

  const prices = updateMemory(tenantId, px);

  const trend = getTrend(prices);
  const momentum = getMomentum(prices);
  const range = getRange(prices);

  const alignment = getAlignmentScore({ trend, momentum, range });

  let action = "WAIT";
  let confidence = alignment;
  let edge = momentum;

  // 🔥 Decision Logic (clean + strong)

  if (alignment > 0.6) {
    if (trend === "UP" && range.nearLow) {
      action = "BUY";
    } else if (trend === "DOWN" && range.nearHigh) {
      action = "SELL";
    }
  }

  // 🔥 Secondary entries (weaker setups)

  if (action === "WAIT" && alignment > 0.45) {
    if (momentum > MIN_EDGE) action = "BUY";
    if (momentum < -MIN_EDGE) action = "SELL";
  }

  // 🔥 Final filters

  if (confidence < MIN_CONFIDENCE) {
    action = "WAIT";
  }

  const levels = buildLevels(action, px, range);

  return {
    symbol,
    action,
    confidence: clamp(confidence, 0, 1),
    edge,
    riskPct: BASE_RISK * confidence,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,

    // 🔥 NEW
    alignmentScore: alignment,
    expectedMoveTime: estimateMoveTime({
      volatility,
      alignment,
    }),

    reason: "alignment_strategy",
    ts: Date.now(),
  };
}

module.exports = {
  buildDecision,
};
