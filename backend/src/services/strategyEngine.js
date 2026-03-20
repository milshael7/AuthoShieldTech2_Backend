// ==========================================================
// FILE: backend/src/services/strategyEngine.js
// VERSION: v18.0 (Maintenance-Safe Exhaustion + Reversal Logic)
// PURPOSE
// - Enter near weak tops / weak bottoms
// - Avoid mid-range fake flips
// - Produce stable stopLoss / takeProfit outputs
// - Stay compatible with tradeBrain + executionEngine
// - Be safer for maintenance and module drift
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
  maxRiskPct: Number(process.env.TRADE_MAX_RISK_PCT || 0.03),
  minRiskPct: Number(process.env.TRADE_MIN_RISK_PCT || 0.002),
});

const MICRO_EDGE =
  Number(process.env.TRADE_MICRO_EDGE || 0.0015);

const MICRO_CONFIDENCE =
  Number(process.env.TRADE_MICRO_CONFIDENCE || 0.45);

const EXHAUSTION_LOOKBACK =
  Number(process.env.TRADE_EXHAUSTION_LOOKBACK || 24);

const SWING_LOOKBACK =
  Number(process.env.TRADE_SWING_LOOKBACK || 8);

const MICRO_TREND_LEN =
  Number(process.env.TRADE_MICRO_TREND_LEN || 5);

const MACRO_TREND_LEN =
  Number(process.env.TRADE_MACRO_TREND_LEN || 80);

const TOP_ZONE_PCT =
  Number(process.env.TRADE_TOP_ZONE_PCT || 0.0025);

const BOTTOM_ZONE_PCT =
  Number(process.env.TRADE_BOTTOM_ZONE_PCT || 0.0025);

const EXHAUSTION_SLOWDOWN_FACTOR =
  Number(process.env.TRADE_EXHAUSTION_SLOWDOWN_FACTOR || 0.65);

const MIN_REVERSAL_EDGE =
  Number(process.env.TRADE_MIN_REVERSAL_EDGE || 0.0008);

const DEFAULT_STOP_BUFFER_PCT =
  Number(process.env.TRADE_STOP_BUFFER_PCT || 0.0018);

const DEFAULT_TP_R_MULTIPLIER =
  Number(process.env.TRADE_TP_R_MULTIPLIER || 1.8);

/* =========================================================
STATE
========================================================= */

const PRICE_MEMORY = new Map();
const STRUCTURE_MEMORY = new Map();

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTenantKey(tenantId) {
  return String(tenantId || "__default__");
}

function avg(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;

  const valid = nums
    .map((n) => safeNum(n, NaN))
    .filter((n) => Number.isFinite(n));

  if (!valid.length) return 0;

  return valid.reduce((sum, n) => sum + n, 0) / valid.length;
}

function getWindow(prices, len) {
  if (!Array.isArray(prices)) return [];
  return prices.slice(-Math.max(1, safeNum(len, 1)));
}

function safeBoost(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* =========================================================
PRICE MEMORY
========================================================= */

function updatePriceMemory(tenantId, price) {
  const key = normalizeTenantKey(tenantId);

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  const prices = PRICE_MEMORY.get(key);

  if (Number.isFinite(price) && price > 0) {
    prices.push(price);
  }

  if (prices.length > 250) {
    prices.splice(0, prices.length - 250);
  }

  return prices;
}

/* =========================================================
STRUCTURE MEMORY
========================================================= */

function getStructureState(tenantId) {
  const key = normalizeTenantKey(tenantId);

  if (!STRUCTURE_MEMORY.has(key)) {
    STRUCTURE_MEMORY.set(key, {
      lastHigh: null,
      lastLow: null,
      structure: "neutral",
      updatedAt: Date.now(),
    });
  }

  return STRUCTURE_MEMORY.get(key);
}

/* =========================================================
TREND / RANGE / MOMENTUM
========================================================= */

function detectTrend(prices, len) {
  if (!Array.isArray(prices) || prices.length < len) {
    return "neutral";
  }

  const a = safeNum(prices[prices.length - len], NaN);
  const b = safeNum(prices[prices.length - 1], NaN);

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return "neutral";
  }

  if (b > a) return "up";
  if (b < a) return "down";
  return "neutral";
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

  const valid = win.filter((n) => Number.isFinite(n) && n > 0);

  if (!valid.length) {
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

  const high = Math.max(...valid);
  const low = Math.min(...valid);
  const last = valid[valid.length - 1];
  const range = Math.max(0, high - low);
  const mid = low + range / 2;

  const distToHighPct =
    last > 0 ? Math.abs(high - last) / last : Infinity;

  const distToLowPct =
    last > 0 ? Math.abs(last - low) / last : Infinity;

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
    const prev = safeNum(win[i - 1], NaN);
    const next = safeNum(win[i], NaN);

    if (Number.isFinite(prev) && Number.isFinite(next)) {
      moves.push(next - prev);
    }
  }

  return moves;
}

function detectMomentumSlowdown(prices, side) {
  const moves = getMomentumSeries(prices, 6);

  if (moves.length < 4) return false;

  const pivot = Math.max(1, Math.floor(moves.length / 2));
  const early = moves.slice(0, pivot);
  const late = moves.slice(pivot);

  const earlyAbs = avg(early.map((x) => Math.abs(x)));
  const lateAbs = avg(late.map((x) => Math.abs(x)));

  if (earlyAbs <= 0 || lateAbs <= 0) return false;

  if (side === "up") {
    const positivePressureEarly = avg(early.map((x) => (x > 0 ? x : 0)));
    const positivePressureLate = avg(late.map((x) => (x > 0 ? x : 0)));

    return (
      positivePressureEarly > 0 &&
      positivePressureLate >= 0 &&
      positivePressureLate <= positivePressureEarly * EXHAUSTION_SLOWDOWN_FACTOR
    );
  }

  if (side === "down") {
    const negativePressureEarly = avg(
      early.map((x) => (x < 0 ? Math.abs(x) : 0))
    );
    const negativePressureLate = avg(
      late.map((x) => (x < 0 ? Math.abs(x) : 0))
    );

    return (
      negativePressureEarly > 0 &&
      negativePressureLate >= 0 &&
      negativePressureLate <= negativePressureEarly * EXHAUSTION_SLOWDOWN_FACTOR
    );
  }

  return false;
}

function detectReversalConfirmation(prices, side) {
  if (!Array.isArray(prices) || prices.length < 4) return false;

  const a = safeNum(prices[prices.length - 4], NaN);
  const b = safeNum(prices[prices.length - 3], NaN);
  const c = safeNum(prices[prices.length - 2], NaN);
  const d = safeNum(prices[prices.length - 1], NaN);

  if (![a, b, c, d].every(Number.isFinite)) {
    return false;
  }

  if (side === "bearish") {
    return b >= a && c <= b && d <= c;
  }

  if (side === "bullish") {
    return b <= a && c >= b && d >= c;
  }

  return false;
}

/* =========================================================
SWINGS / STRUCTURE
========================================================= */

function detectSwingLow(prices) {
  if (!Array.isArray(prices) || prices.length < 6) return false;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    Number.isFinite(d) &&
    Number.isFinite(e) &&
    Number.isFinite(f) &&
    a > b &&
    b > c &&
    c < d &&
    d <= e &&
    e <= f
  );
}

function detectSwingHigh(prices) {
  if (!Array.isArray(prices) || prices.length < 6) return false;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    Number.isFinite(d) &&
    Number.isFinite(e) &&
    Number.isFinite(f) &&
    a < b &&
    b < c &&
    c > d &&
    d >= e &&
    e >= f
  );
}

function updateStructure(tenantId, price, swingHigh, swingLow) {
  const state = getStructureState(tenantId);

  if (swingHigh) {
    if (Number.isFinite(state.lastHigh) && price > state.lastHigh) {
      state.structure = "HH";
    } else if (Number.isFinite(state.lastHigh) && price < state.lastHigh) {
      state.structure = "LH";
    }

    state.lastHigh = price;
  }

  if (swingLow) {
    if (Number.isFinite(state.lastLow) && price > state.lastLow) {
      state.structure = "HL";
    } else if (Number.isFinite(state.lastLow) && price < state.lastLow) {
      state.structure = "LL";
    }

    state.lastLow = price;
  }

  state.updatedAt = Date.now();
  return state.structure;
}

/* =========================================================
LIQUIDITY SIGNALS
========================================================= */

function detectLiquidityGravity(prices) {
  if (!Array.isArray(prices) || prices.length < 20) {
    return "neutral";
  }

  const recent = prices.slice(-20).filter((n) => Number.isFinite(n) && n > 0);
  if (recent.length < 2) return "neutral";

  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const last = recent[recent.length - 1];

  const distHigh = Math.abs(max - last) / Math.max(last, 1);
  const distLow = Math.abs(last - min) / Math.max(last, 1);

  if (distHigh < distLow) return "up";
  if (distLow < distHigh) return "down";

  return "neutral";
}

function detectLiquiditySweep(prices) {
  if (!Array.isArray(prices) || prices.length < SWING_LOOKBACK) {
    return false;
  }

  const compareWindow = prices
    .slice(-SWING_LOOKBACK, -2)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (compareWindow.length < 2) return false;

  const prevHigh = Math.max(...compareWindow);
  const prevLow = Math.min(...compareWindow);
  const prev = safeNum(prices[prices.length - 2], NaN);
  const last = safeNum(prices[prices.length - 1], NaN);

  if (!Number.isFinite(prev) || !Number.isFinite(last)) {
    return false;
  }

  if (prev > prevHigh && last < prev) return "bearish";
  if (prev < prevLow && last > prev) return "bullish";

  return false;
}

/* =========================================================
EXTERNAL ENGINE SAFETY
========================================================= */

function getPatternBoost({ tenantId, symbol, volatility }) {
  try {
    if (typeof patternEngine?.getPatternEdgeBoost === "function") {
      return safeBoost(
        patternEngine.getPatternEdgeBoost({
          tenantId,
          symbol,
          volatility,
        }),
        1
      );
    }
  } catch {}

  return 1;
}

function getRegime(price, lastPrice, volatility) {
  try {
    if (typeof regimeMemory?.detectRegime === "function") {
      return (
        regimeMemory.detectRegime({
          price,
          lastPrice,
          volatility,
        }) || "neutral"
      );
    }
  } catch {}

  return "neutral";
}

function getRegimeBoost({ tenantId, regime }) {
  try {
    if (typeof regimeMemory?.getRegimeBoost === "function") {
      return safeBoost(
        regimeMemory.getRegimeBoost({
          tenantId,
          regime,
        }),
        1
      );
    }
  } catch {}

  return 1;
}

function getCorrelationBoost({ tenantId, symbol }) {
  try {
    if (typeof correlationEngine?.getCorrelationBoost === "function") {
      return safeBoost(
        correlationEngine.getCorrelationBoost({
          tenantId,
          symbol,
        }),
        1
      );
    }
  } catch {}

  return 1;
}

function getFlowBoost({ tenantId }) {
  try {
    if (typeof orderFlowEngine?.analyzeFlow === "function") {
      const flow = orderFlowEngine.analyzeFlow({ tenantId }) || {};
      return safeBoost(flow.boost, 1);
    }
  } catch {}

  return 1;
}

function getLearningBoost({ tenantId }) {
  try {
    if (typeof counterfactualEngine?.getLearningAdjustment === "function") {
      return safeBoost(
        counterfactualEngine.getLearningAdjustment({
          tenantId,
        }),
        1
      );
    }
  } catch {}

  return 1;
}

/* =========================================================
EDGE / CONFIDENCE / RISK
========================================================= */

function computeEdge({ price, lastPrice, volatility, regime }) {
  const last = safeNum(lastPrice, 0);
  const px = safeNum(price, 0);

  if (px <= 0 || last <= 0) return 0;

  const volBase = Math.max(safeNum(volatility, 0.002), 0.0001);
  const rawMomentum = (px - last) / last;
  let normalized = rawMomentum / volBase;

  if (regime === "trend") normalized *= 1.25;
  if (regime === "range") normalized *= 0.8;
  if (regime === "volatility_expansion") normalized *= 1.35;

  return clamp(normalized, -0.07, 0.07);
}

function computeConfidence(edge) {
  return clamp(Math.abs(safeNum(edge, 0)) * 18, 0.05, 1);
}

function computeRisk({ confidence, volatility, regime }) {
  let risk = BASE_CONFIG.baseRiskPct;
  const conf = safeNum(confidence, 0);
  const vol = safeNum(volatility, 0);

  if (conf > 0.85) risk *= 2.4;
  else if (conf > 0.7) risk *= 1.7;
  else if (conf > 0.55) risk *= 1.2;
  else risk *= 0.6;

  if (vol > 0.01) risk *= 0.6;
  if (vol > 0.015) risk *= 0.4;

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
    return {
      stopLoss: null,
      takeProfit: null,
    };
  }

  const volBuffer = Math.max(px * safeNum(volatility, 0.002) * 0.8, 0);
  const defaultBuffer = px * DEFAULT_STOP_BUFFER_PCT;
  const stopBuffer = Math.max(defaultBuffer, volBuffer * 0.35);

  if (action === "BUY") {
    const structuralStop =
      safeNum(rangeStats?.low, px) - stopBuffer;

    const stopLoss =
      structuralStop < px ? structuralStop : px - stopBuffer;

    const riskPerUnit = Math.max(px - stopLoss, px * 0.0015);
    const takeProfit = px + riskPerUnit * DEFAULT_TP_R_MULTIPLIER;

    return {
      stopLoss,
      takeProfit,
    };
  }

  if (action === "SELL") {
    const structuralStop =
      safeNum(rangeStats?.high, px) + stopBuffer;

    const stopLoss =
      structuralStop > px ? structuralStop : px + stopBuffer;

    const riskPerUnit = Math.max(stopLoss - px, px * 0.0015);
    const takeProfit = px - riskPerUnit * DEFAULT_TP_R_MULTIPLIER;

    return {
      stopLoss,
      takeProfit,
    };
  }

  return {
    stopLoss: null,
    takeProfit: null,
  };
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
    symbol: String(symbol || "BTCUSDT").toUpperCase(),
    action: String(action || "WAIT").toUpperCase(),
    confidence: clamp(safeNum(confidence, 0.05), 0.05, 1),
    edge: clamp(safeNum(edge, 0), -0.07, 0.07),
    riskPct: clamp(
      safeNum(riskPct, BASE_CONFIG.baseRiskPct),
      BASE_CONFIG.minRiskPct,
      BASE_CONFIG.maxRiskPct
    ),
    regime: regime || "neutral",
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

  const px = safeNum(price, NaN);
  const last = safeNum(lastPrice, NaN);
  const vol = Math.max(safeNum(volatility, 0.002), 0);

  if (!Number.isFinite(px) || px <= 0) {
    return formatDecision({
      symbol,
      action: "WAIT",
      confidence: 0.05,
      edge: 0,
      riskPct: BASE_CONFIG.minRiskPct,
      regime: "unknown",
      reason: "invalid_price",
      stopLoss: null,
      takeProfit: null,
    });
  }

  const prices = updatePriceMemory(tenantId, px);

  const swingLow = detectSwingLow(prices);
  const swingHigh = detectSwingHigh(prices);

  const structure = updateStructure(
    tenantId,
    px,
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

  const regime = getRegime(px, last, vol);

  let edge = computeEdge({
    price: px,
    lastPrice: last,
    volatility: vol,
    regime,
  });

  edge *= getPatternBoost({
    tenantId,
    symbol,
    volatility: vol,
  });

  edge *= getRegimeBoost({
    tenantId,
    regime,
  });

  edge *= getCorrelationBoost({
    tenantId,
    symbol,
  });

  let confidence = computeConfidence(edge);

  const flowBoost = getFlowBoost({ tenantId });
  confidence *= flowBoost;
  edge *= flowBoost;

  const learningBoost = getLearningBoost({ tenantId });
  confidence *= learningBoost;
  edge *= learningBoost;

  if (liquidityGravity === "up" && microTrend === "up") {
    confidence *= 1.04;
  }

  if (liquidityGravity === "down" && microTrend === "down") {
    confidence *= 1.04;
  }

  edge = clamp(edge, -0.07, 0.07);
  confidence = clamp(confidence, 0.05, 1);

  let riskPct = computeRisk({
    confidence,
    volatility: vol,
    regime,
  });

  const isMidRange =
    !rangeStats.inTopZone &&
    !rangeStats.inBottomZone &&
    Number.isFinite(rangeStats.mid);

  /* =========================================================
  PRIMARY REVERSAL LOGIC
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
      price: px,
      rangeStats,
      volatility: vol,
    });

    return formatDecision({
      symbol,
      action: "SELL",
      confidence: boostedConfidence,
      edge: Math.min(edge, -MIN_REVERSAL_EDGE),
      riskPct: clamp(
        riskPct * 1.05,
        BASE_CONFIG.minRiskPct,
        BASE_CONFIG.maxRiskPct
      ),
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
      price: px,
      rangeStats,
      volatility: vol,
    });

    return formatDecision({
      symbol,
      action: "BUY",
      confidence: boostedConfidence,
      edge: Math.max(edge, MIN_REVERSAL_EDGE),
      riskPct: clamp(
        riskPct * 1.05,
        BASE_CONFIG.minRiskPct,
        BASE_CONFIG.maxRiskPct
      ),
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
      price: px,
      rangeStats,
      volatility: vol,
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
      price: px,
      rangeStats,
      volatility: vol,
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
      price: px,
      rangeStats,
      volatility: vol,
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
      price: px,
      rangeStats,
      volatility: vol,
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
  ========================================================= */

  if (
    !isMidRange &&
    Math.abs(edge) > MICRO_EDGE &&
    confidence > MICRO_CONFIDENCE
  ) {
    if (microTrend === "up") {
      const levels = buildTradeLevels({
        action: "BUY",
        price: px,
        rangeStats,
        volatility: vol,
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
        price: px,
        rangeStats,
        volatility: vol,
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

  return formatDecision({
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
  });
}

function makeDecision(context = {}) {
  return buildDecision(context);
}

function resetTenant(tenantId) {
  const key = normalizeTenantKey(tenantId);
  PRICE_MEMORY.delete(key);
  STRUCTURE_MEMORY.delete(key);

  return {
    ok: true,
    tenantId: key,
  };
}

module.exports = {
  buildDecision,
  makeDecision,
  resetTenant,
};
