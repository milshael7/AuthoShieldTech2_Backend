// ==========================================================
// FILE: backend/src/services/strategyEngine.js
// VERSION: v17.0 (Exhaustion + Reversal Structure Logic)
// PURPOSE
// - Enter near weak tops / weak bottoms
// - Avoid mid-range fake flips
// - Produce clearer stopLoss / takeProfit outputs
// - Stay compatible with tradeBrain + executionEngine
// ==========================================================

const patternEngine = require("./patternEngine");
const regimeMemory = require("./regimeMemory");
const orderFlowEngine = require("./orderFlowEngine");
const correlationEngine = require("./correlationEngine");
const counterfactualEngine = require("./counterfactualEngine");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const BASE_CONFIG = Object.freeze({
  baseRiskPct: Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct: 0.03,
  minRiskPct: 0.002,
});

const MICRO_EDGE = 0.0015;
const MICRO_CONFIDENCE = 0.45;

const EXHAUSTION_LOOKBACK = 24;
const SWING_LOOKBACK = 8;
const MICRO_TREND_LEN = 5;
const MACRO_TREND_LEN = 80;

const TOP_ZONE_PCT = Number(process.env.TRADE_TOP_ZONE_PCT || 0.0025);
const BOTTOM_ZONE_PCT = Number(process.env.TRADE_BOTTOM_ZONE_PCT || 0.0025);

const EXHAUSTION_SLOWDOWN_FACTOR =
  Number(process.env.TRADE_EXHAUSTION_SLOWDOWN_FACTOR || 0.65);

const MIN_REVERSAL_EDGE = Number(process.env.TRADE_MIN_REVERSAL_EDGE || 0.0008);

const DEFAULT_STOP_BUFFER_PCT =
  Number(process.env.TRADE_STOP_BUFFER_PCT || 0.0018);

const DEFAULT_TP_R_MULTIPLIER =
  Number(process.env.TRADE_TP_R_MULTIPLIER || 1.8);

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_MEMORY = new Map();
const STRUCTURE_MEMORY = new Map();

function updatePriceMemory(tenantId, price) {
  const key = tenantId || "__default__";

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  const arr = PRICE_MEMORY.get(key);

  if (Number.isFinite(price)) {
    arr.push(price);
  }

  if (arr.length > 250) {
    arr.shift();
  }

  return arr;
}

/* =========================================================
STRUCTURE
========================================================= */

function getStructureState(tenantId) {
  const key = tenantId || "__default__";

  if (!STRUCTURE_MEMORY.has(key)) {
    STRUCTURE_MEMORY.set(key, {
      lastHigh: null,
      lastLow: null,
      structure: "neutral",
    });
  }

  return STRUCTURE_MEMORY.get(key);
}

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function avg(nums) {
  if (!Array.isArray(nums) || !nums.length) return 0;
  return nums.reduce((a, b) => a + safeNum(b, 0), 0) / nums.length;
}

function detectTrend(prices, len) {
  if (prices.length < len) return "neutral";

  const a = prices[prices.length - len];
  const b = prices[prices.length - 1];

  if (b > a) return "up";
  if (b < a) return "down";

  return "neutral";
}

function getWindow(prices, len) {
  if (!Array.isArray(prices)) return [];
  return prices.slice(-len);
}

function getRangeStats(prices, len = EXHAUSTION_LOOKBACK) {
  const win = getWindow(prices, len);
  if (!win.length) {
    return {
      high: null,
      low: null,
      range: 0,
      mid: null,
      last: null,
      distToHighPct: Infinity,
      distToLowPct: Infinity,
      inTopZone: false,
      inBottomZone: false,
    };
  }

  const high = Math.max(...win);
  const low = Math.min(...win);
  const last = win[win.length - 1];
  const range = Math.max(0, high - low);
  const mid = low + range / 2;

  const distToHighPct = last > 0 ? Math.abs(high - last) / last : Infinity;
  const distToLowPct = last > 0 ? Math.abs(last - low) / last : Infinity;

  return {
    high,
    low,
    range,
    mid,
    last,
    distToHighPct,
    distToLowPct,
    inTopZone: distToHighPct <= TOP_ZONE_PCT,
    inBottomZone: distToLowPct <= BOTTOM_ZONE_PCT,
  };
}

function getMomentumSeries(prices, len = 6) {
  const win = getWindow(prices, len + 1);
  const moves = [];

  for (let i = 1; i < win.length; i += 1) {
    moves.push(win[i] - win[i - 1]);
  }

  return moves;
}

function detectMomentumSlowdown(prices, side) {
  const moves = getMomentumSeries(prices, 6);
  if (moves.length < 4) return false;

  const early = moves.slice(0, Math.max(1, Math.floor(moves.length / 2)));
  const late = moves.slice(Math.max(1, Math.floor(moves.length / 2)));

  const earlyAbs = avg(early.map((x) => Math.abs(x)));
  const lateAbs = avg(late.map((x) => Math.abs(x)));

  if (earlyAbs <= 0 || lateAbs <= 0) return false;

  if (side === "up") {
    const positivePressureEarly = avg(early.map((x) => (x > 0 ? x : 0)));
    const positivePressureLate = avg(late.map((x) => (x > 0 ? x : 0)));

    return (
      positivePressureEarly > 0 &&
      positivePressureLate > 0 &&
      positivePressureLate <= positivePressureEarly * EXHAUSTION_SLOWDOWN_FACTOR
    );
  }

  if (side === "down") {
    const negativePressureEarly = avg(early.map((x) => (x < 0 ? Math.abs(x) : 0)));
    const negativePressureLate = avg(late.map((x) => (x < 0 ? Math.abs(x) : 0)));

    return (
      negativePressureEarly > 0 &&
      negativePressureLate > 0 &&
      negativePressureLate <= negativePressureEarly * EXHAUSTION_SLOWDOWN_FACTOR
    );
  }

  return false;
}

function detectReversalConfirmation(prices, side) {
  if (prices.length < 4) return false;

  const a = prices[prices.length - 4];
  const b = prices[prices.length - 3];
  const c = prices[prices.length - 2];
  const d = prices[prices.length - 1];

  if (side === "bearish") {
    return b >= a && c <= b && d <= c;
  }

  if (side === "bullish") {
    return b <= a && c >= b && d >= c;
  }

  return false;
}

function detectSwingLow(prices) {
  if (prices.length < 6) return false;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  return a > b && b > c && c < d && d <= e && e <= f;
}

function detectSwingHigh(prices) {
  if (prices.length < 6) return false;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  return a < b && b < c && c > d && d >= e && e >= f;
}

function updateStructure(tenantId, price, swingHigh, swingLow) {
  const s = getStructureState(tenantId);

  if (swingHigh) {
    if (s.lastHigh && price > s.lastHigh) s.structure = "HH";
    else if (s.lastHigh && price < s.lastHigh) s.structure = "LH";

    s.lastHigh = price;
  }

  if (swingLow) {
    if (s.lastLow && price > s.lastLow) s.structure = "HL";
    else if (s.lastLow && price < s.lastLow) s.structure = "LL";

    s.lastLow = price;
  }

  return s.structure;
}

function detectLiquidityGravity(prices) {
  if (prices.length < 20) return "neutral";

  const recent = prices.slice(-20);
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const last = prices[prices.length - 1];

  const distHigh = Math.abs(max - last) / Math.max(last, 1);
  const distLow = Math.abs(last - min) / Math.max(last, 1);

  if (distHigh < distLow) return "up";
  if (distLow < distHigh) return "down";

  return "neutral";
}

function detectLiquiditySweep(prices) {
  if (prices.length < SWING_LOOKBACK) return false;

  const prevHigh = Math.max(...prices.slice(-8, -2));
  const prevLow = Math.min(...prices.slice(-8, -2));
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];

  if (prev > prevHigh && last < prev) return "bearish";
  if (prev < prevLow && last > prev) return "bullish";

  return false;
}

/* =========================================================
EDGE MODEL
========================================================= */

function computeEdge({ price, lastPrice, volatility, regime }) {
  if (!lastPrice) return 0;

  const rawMomentum = (price - lastPrice) / lastPrice;
  let normalized = rawMomentum / (volatility || 0.002);

  if (regime === "trend") normalized *= 1.25;
  if (regime === "range") normalized *= 0.8;
  if (regime === "volatility_expansion") normalized *= 1.35;

  return clamp(normalized, -0.07, 0.07);
}

function computeConfidence(edge) {
  return clamp(Math.abs(edge) * 18, 0.05, 1);
}

/* =========================================================
RISK ENGINE
========================================================= */

function computeRisk({ confidence, volatility, regime }) {
  let risk = BASE_CONFIG.baseRiskPct;

  if (confidence > 0.85) risk *= 2.4;
  else if (confidence > 0.7) risk *= 1.7;
  else if (confidence > 0.55) risk *= 1.2;
  else risk *= 0.6;

  if (volatility > 0.01) risk *= 0.6;
  if (volatility > 0.015) risk *= 0.4;

  if (regime === "range") risk *= 0.7;
  if (regime === "volatility_expansion") risk *= 0.75;

  return clamp(risk, BASE_CONFIG.minRiskPct, BASE_CONFIG.maxRiskPct);
}

/* =========================================================
TRADE LEVELS
========================================================= */

function buildTradeLevels({
  action,
  price,
  rangeStats,
  volatility,
}) {
  const px = safeNum(price, 0);
  if (px <= 0) {
    return { stopLoss: null, takeProfit: null };
  }

  const volBuffer = Math.max(px * safeNum(volatility, 0.002) * 0.8, 0);
  const defaultBuffer = px * DEFAULT_STOP_BUFFER_PCT;
  const stopBuffer = Math.max(defaultBuffer, volBuffer * 0.35);

  if (action === "BUY") {
    const structuralStop = safeNum(rangeStats.low, px) - stopBuffer;
    const stopLoss = structuralStop < px ? structuralStop : px - stopBuffer;
    const riskPerUnit = Math.max(px - stopLoss, px * 0.0015);
    const takeProfit = px + riskPerUnit * DEFAULT_TP_R_MULTIPLIER;

    return {
      stopLoss,
      takeProfit,
    };
  }

  if (action === "SELL") {
    const structuralStop = safeNum(rangeStats.high, px) + stopBuffer;
    const stopLoss = structuralStop > px ? structuralStop : px + stopBuffer;
    const riskPerUnit = Math.max(stopLoss - px, px * 0.0015);
    const takeProfit = px - riskPerUnit * DEFAULT_TP_R_MULTIPLIER;

    return {
      stopLoss,
      takeProfit,
    };
  }

  return { stopLoss: null, takeProfit: null };
}

/* =========================================================
DECISION FORMATTER
========================================================= */

function formatDecision({
  symbol,
  action,
  confidence,
  edge,
  riskPct,
  regime,
  slot = "scalp",
  reason = "signal",
  stopLoss = null,
  takeProfit = null,
}) {
  return {
    symbol,
    action,
    confidence: clamp(safeNum(confidence, 0.05), 0.05, 1),
    edge: clamp(safeNum(edge, 0), -0.07, 0.07),
    riskPct: clamp(
      safeNum(riskPct, BASE_CONFIG.baseRiskPct),
      BASE_CONFIG.minRiskPct,
      BASE_CONFIG.maxRiskPct
    ),
    regime,
    slot,
    reason,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
    ts: Date.now(),
  };
}

/* =========================================================
CORE DECISION
========================================================= */

function buildDecision(context = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    price,
    lastPrice,
    volatility,
  } = context;

  if (!Number.isFinite(price) || price <= 0) {
    return {
      action: "WAIT",
      confidence: 0.05,
      edge: 0,
      regime: "unknown",
      reason: "invalid_price",
    };
  }

  const prices = updatePriceMemory(tenantId, price);

  const swingLow = detectSwingLow(prices);
  const swingHigh = detectSwingHigh(prices);

  const structure = updateStructure(
    tenantId,
    price,
    swingHigh,
    swingLow
  );

  const liquiditySweep = detectLiquiditySweep(prices);
  const liquidityGravity = detectLiquidityGravity(prices);
  const microTrend = detectTrend(prices, MICRO_TREND_LEN);
  const macroTrend = detectTrend(prices, MACRO_TREND_LEN);

  const rangeStats = getRangeStats(prices, EXHAUSTION_LOOKBACK);
  const topExhaustion =
    rangeStats.inTopZone &&
    detectMomentumSlowdown(prices, "up") &&
    detectReversalConfirmation(prices, "bearish");

  const bottomExhaustion =
    rangeStats.inBottomZone &&
    detectMomentumSlowdown(prices, "down") &&
    detectReversalConfirmation(prices, "bullish");

  const regime =
    regimeMemory.detectRegime({
      price,
      lastPrice,
      volatility,
    }) || "neutral";

  let edge = computeEdge({
    price,
    lastPrice,
    volatility,
    regime,
  });

  edge *= patternEngine.getPatternEdgeBoost({
    tenantId,
    symbol,
    volatility,
  });

  edge *= regimeMemory.getRegimeBoost({
    tenantId,
    regime,
  });

  edge *= correlationEngine.getCorrelationBoost({
    tenantId,
    symbol,
  });

  let confidence = computeConfidence(edge);

  const flow = orderFlowEngine.analyzeFlow({ tenantId }) || {};
  confidence *= flow.boost || 1;
  edge *= flow.boost || 1;

  const learningBoost =
    counterfactualEngine.getLearningAdjustment?.({
      tenantId,
    }) || 1;

  confidence *= learningBoost;
  edge *= learningBoost;

  if (liquidityGravity === "up" && microTrend === "up") confidence *= 1.04;
  if (liquidityGravity === "down" && microTrend === "down") confidence *= 1.04;

  edge = clamp(edge, -0.07, 0.07);
  confidence = clamp(confidence, 0.05, 1);

  let riskPct = computeRisk({
    confidence,
    volatility,
    regime,
  });

  /* =========================================================
  PRIMARY REVERSAL LOGIC
  Your preferred behavior:
  - short weakness near the top
  - buy weakness near the bottom
  - do not flip in the middle
  ========================================================= */

  if (
    topExhaustion &&
    macroTrend !== "up" &&
    Math.abs(edge) >= MIN_REVERSAL_EDGE
  ) {
    const boostedConfidence = clamp(
      Math.max(confidence, 0.78) * 1.08,
      0.05,
      1
    );

    const levels = buildTradeLevels({
      action: "SELL",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "SELL",
      confidence: boostedConfidence,
      edge: Math.min(edge, -MIN_REVERSAL_EDGE) || -MIN_REVERSAL_EDGE,
      riskPct: clamp(riskPct * 1.05, BASE_CONFIG.minRiskPct, BASE_CONFIG.maxRiskPct),
      regime,
      slot: "scalp",
      reason: "top_exhaustion_reversal",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  if (
    bottomExhaustion &&
    macroTrend !== "down" &&
    Math.abs(edge) >= MIN_REVERSAL_EDGE
  ) {
    const boostedConfidence = clamp(
      Math.max(confidence, 0.78) * 1.08,
      0.05,
      1
    );

    const levels = buildTradeLevels({
      action: "BUY",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "BUY",
      confidence: boostedConfidence,
      edge: Math.max(edge, MIN_REVERSAL_EDGE) || MIN_REVERSAL_EDGE,
      riskPct: clamp(riskPct * 1.05, BASE_CONFIG.minRiskPct, BASE_CONFIG.maxRiskPct),
      regime,
      slot: "scalp",
      reason: "bottom_exhaustion_reversal",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  /* =========================================================
  SECONDARY STRUCTURE TRADES
  ========================================================= */

  if (
    swingLow &&
    structure === "HL" &&
    macroTrend !== "down" &&
    microTrend === "up" &&
    rangeStats.inBottomZone
  ) {
    const levels = buildTradeLevels({
      action: "BUY",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "BUY",
      confidence,
      edge: Math.max(edge, MIN_REVERSAL_EDGE),
      riskPct,
      regime,
      slot: "scalp",
      reason: "higher_low_reversal",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  if (
    swingHigh &&
    structure === "LH" &&
    macroTrend !== "up" &&
    microTrend === "down" &&
    rangeStats.inTopZone
  ) {
    const levels = buildTradeLevels({
      action: "SELL",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "SELL",
      confidence,
      edge: Math.min(edge, -MIN_REVERSAL_EDGE),
      riskPct,
      regime,
      slot: "scalp",
      reason: "lower_high_reversal",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  /* =========================================================
  LIQUIDITY SWEEP REVERSALS
  ========================================================= */

  if (liquiditySweep === "bullish" && rangeStats.inBottomZone) {
    const levels = buildTradeLevels({
      action: "BUY",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "BUY",
      confidence: confidence * 0.92,
      edge: Math.max(edge, 0.003),
      riskPct,
      regime,
      slot: "scalp",
      reason: "bullish_liquidity_sweep",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  if (liquiditySweep === "bearish" && rangeStats.inTopZone) {
    const levels = buildTradeLevels({
      action: "SELL",
      price,
      rangeStats,
      volatility,
    });

    return formatDecision({
      symbol,
      action: "SELL",
      confidence: confidence * 0.92,
      edge: Math.min(edge, -0.003),
      riskPct,
      regime,
      slot: "scalp",
      reason: "bearish_liquidity_sweep",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
  }

  /* =========================================================
  MICRO OPPORTUNITY ENGINE
  Only if price is not stuck in the middle.
  ========================================================= */

  const isMidRange =
    !rangeStats.inTopZone &&
    !rangeStats.inBottomZone &&
    Number.isFinite(rangeStats.mid);

  if (
    !isMidRange &&
    Math.abs(edge) > MICRO_EDGE &&
    confidence > MICRO_CONFIDENCE
  ) {
    if (microTrend === "up") {
      const levels = buildTradeLevels({
        action: "BUY",
        price,
        rangeStats,
        volatility,
      });

      return formatDecision({
        symbol,
        action: "BUY",
        confidence: confidence * 0.8,
        edge,
        riskPct: riskPct * 0.5,
        regime,
        slot: "scalp",
        reason: "micro_opportunity_buy",
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
      });
    }

    if (microTrend === "down") {
      const levels = buildTradeLevels({
        action: "SELL",
        price,
        rangeStats,
        volatility,
      });

      return formatDecision({
        symbol,
        action: "SELL",
        confidence: confidence * 0.8,
        edge,
        riskPct: riskPct * 0.5,
        regime,
        slot: "scalp",
        reason: "micro_opportunity_sell",
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
      });
    }
  }

  return {
    symbol,
    action: "WAIT",
    confidence,
    edge,
    riskPct,
    regime,
    slot: "scalp",
    reason: isMidRange ? "mid_range_noise" : "no_valid_setup",
    stopLoss: null,
    takeProfit: null,
    ts: Date.now(),
  };
}

function makeDecision(context) {
  return buildDecision(context);
}

module.exports = {
  buildDecision,
  makeDecision,
};
