// ==========================================================
// FILE: backend/src/services/strategyDiscovery.js
// VERSION: v2.0 (Maintenance-Safe Discovery + Weakness-Aligned)
// PURPOSE
// Discover candidate strategy profiles, validate them on replay,
// and keep the output aligned with the live execution model.
//
// FIXES
// - No more random-only blind discovery
// - Scores strategies against your actual weak-top / weak-bottom idea
// - Safe fallbacks if training/replay engines drift
// - Maintenance-friendly helpers and normalized outputs
// - Produces build-ready strategy profile objects for later use
// ==========================================================

const trainingEngine = require("./trainingEngine");
const replayEngine = require("./marketReplayEngine");

/* =========================================================
CONFIG
========================================================= */

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_DISCOVERY_VARIANTS = Number(
  process.env.STRATEGY_DISCOVERY_VARIANTS || 24
);

const DEFAULT_MIN_CONFIDENCE = Number(
  process.env.STRATEGY_DISCOVERY_MIN_CONFIDENCE || 0.52
);

const DEFAULT_MAX_CONFIDENCE = Number(
  process.env.STRATEGY_DISCOVERY_MAX_CONFIDENCE || 0.9
);

const DEFAULT_MIN_EDGE = Number(
  process.env.STRATEGY_DISCOVERY_MIN_EDGE || 0.0006
);

const DEFAULT_MAX_EDGE = Number(
  process.env.STRATEGY_DISCOVERY_MAX_EDGE || 0.006
);

const DEFAULT_MIN_RISK_MULTIPLIER = Number(
  process.env.STRATEGY_DISCOVERY_MIN_RISK_MULTIPLIER || 0.5
);

const DEFAULT_MAX_RISK_MULTIPLIER = Number(
  process.env.STRATEGY_DISCOVERY_MAX_RISK_MULTIPLIER || 1.6
);

const DEFAULT_LOOKBACK = Number(
  process.env.STRATEGY_DISCOVERY_LOOKBACK || 6
);

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function randomBetween(min, max) {
  const a = safeNum(min, 0);
  const b = safeNum(max, a);
  return Math.random() * (b - a) + a;
}

function pickOne(list, fallback = null) {
  const arr = asArray(list);
  if (!arr.length) return fallback;
  return arr[Math.floor(Math.random() * arr.length)];
}

function round(v, digits = 6) {
  return Number(safeNum(v, 0).toFixed(digits));
}

function normalizeCandle(candle = {}) {
  const open = safeNum(candle.open, safeNum(candle.o, 0));
  const high = safeNum(candle.high, safeNum(candle.h, open));
  const low = safeNum(candle.low, safeNum(candle.l, open));
  const close = safeNum(candle.close, safeNum(candle.c, open));
  const volume = safeNum(candle.volume, safeNum(candle.v, 0));
  const time =
    candle.time ??
    candle.ts ??
    candle.timestamp ??
    candle.openTime ??
    Date.now();

  return {
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume,
    time,
  };
}

function getCandleClose(candle) {
  return normalizeCandle(candle).close;
}

function getCandlesSafe(symbol) {
  try {
    const raw = replayEngine?.replayCandles?.({ symbol });
    return asArray(raw).map(normalizeCandle).filter((c) => c.close > 0);
  } catch {
    return [];
  }
}

/* =========================================================
WEAKNESS / REVERSAL DISCOVERY MODEL
---------------------------------------------------------
This tries to match what you described:
- market pushes up, gets weaker at the top -> look for SELL
- market pushes down, gets weaker at the bottom -> look for BUY
- we do not want random mid-move chasing
========================================================= */

function isRising(seq) {
  if (seq.length < 3) return false;
  for (let i = 1; i < seq.length; i += 1) {
    if (!(seq[i] >= seq[i - 1])) return false;
  }
  return true;
}

function isFalling(seq) {
  if (seq.length < 3) return false;
  for (let i = 1; i < seq.length; i += 1) {
    if (!(seq[i] <= seq[i - 1])) return false;
  }
  return true;
}

function detectWeakTop(prices) {
  if (prices.length < 6) return null;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  const leadIn = [a, b, c, d];
  const topZone = [d, e, f];

  const risingIntoTop = isRising(leadIn);
  const losingMomentum =
    (d - c) >= 0 &&
    (e - d) <= (d - c) &&
    (f - e) <= (e - d);

  const rollover = f < e || (f <= e && e <= d);
  const localPeak = d >= c && d >= e;

  if (risingIntoTop && losingMomentum && rollover && localPeak) {
    return {
      direction: "SHORT",
      weakness: "TOP",
      confidenceBoost: 1.12,
      triggerIndexOffset: prices.length - 1,
    };
  }

  return null;
}

function detectWeakBottom(prices) {
  if (prices.length < 6) return null;

  const a = prices[prices.length - 6];
  const b = prices[prices.length - 5];
  const c = prices[prices.length - 4];
  const d = prices[prices.length - 3];
  const e = prices[prices.length - 2];
  const f = prices[prices.length - 1];

  const leadIn = [a, b, c, d];
  const bottomZone = [d, e, f];

  const fallingIntoBottom = isFalling(leadIn);
  const losingMomentum =
    (c - d) >= 0 &&
    (d - e) <= (c - d) &&
    (e - f) <= (d - e);

  const rebound = f > e || (f >= e && e >= d);
  const localLow = d <= c && d <= e;

  if (fallingIntoBottom && losingMomentum && rebound && localLow) {
    return {
      direction: "LONG",
      weakness: "BOTTOM",
      confidenceBoost: 1.12,
      triggerIndexOffset: prices.length - 1,
    };
  }

  return null;
}

function detectDiscoverySignal(candles, lookback = DEFAULT_LOOKBACK) {
  const closes = candles.slice(-Math.max(lookback, 6)).map(getCandleClose);

  const weakTop = detectWeakTop(closes);
  if (weakTop) return weakTop;

  const weakBottom = detectWeakBottom(closes);
  if (weakBottom) return weakBottom;

  return null;
}

/* =========================================================
STRATEGY PROFILE GENERATION
========================================================= */

function generateStrategyProfile(seed = {}) {
  const style = pickOne(
    ["reversal_precision", "reversal_confirmed", "reversal_aggressive"],
    "reversal_confirmed"
  );

  let confidenceThreshold = randomBetween(
    DEFAULT_MIN_CONFIDENCE,
    DEFAULT_MAX_CONFIDENCE
  );

  let edgeThreshold = randomBetween(DEFAULT_MIN_EDGE, DEFAULT_MAX_EDGE);
  let riskMultiplier = randomBetween(
    DEFAULT_MIN_RISK_MULTIPLIER,
    DEFAULT_MAX_RISK_MULTIPLIER
  );

  let confirmBars = pickOne([1, 2, 2, 3], 2);
  let stopBufferPct = pickOne([0.0015, 0.002, 0.0025, 0.003], 0.002);
  let trailingMode = pickOne(
    ["NONE", "BREAK_EVEN", "TRAIL_RETRACE"],
    "TRAIL_RETRACE"
  );
  let trailingRetracePct = pickOne([0.18, 0.22, 0.25, 0.3], 0.22);
  let maxHoldBars = pickOne([4, 6, 8, 10], 6);
  let entryMode = pickOne(["WEAKNESS_EDGE", "CONFIRM_AFTER_STALL"], "WEAKNESS_EDGE");

  if (style === "reversal_precision") {
    confidenceThreshold = Math.max(confidenceThreshold, 0.68);
    edgeThreshold = Math.min(edgeThreshold, 0.003);
    riskMultiplier = Math.min(riskMultiplier, 1.0);
    confirmBars = 2;
    stopBufferPct = 0.0018;
    maxHoldBars = 6;
  }

  if (style === "reversal_aggressive") {
    confidenceThreshold = Math.min(confidenceThreshold, 0.62);
    edgeThreshold = Math.min(edgeThreshold, 0.0022);
    riskMultiplier = Math.min(Math.max(riskMultiplier, 1.0), 1.35);
    confirmBars = 1;
    stopBufferPct = 0.0025;
    maxHoldBars = 4;
  }

  if (seed && typeof seed === "object") {
    if (seed.style) style = String(seed.style);
  }

  return {
    version: "discovery-v2",
    family: "weakness-reversal",
    style,
    entryMode,
    confidenceThreshold: round(confidenceThreshold, 4),
    edgeThreshold: round(edgeThreshold, 6),
    riskMultiplier: round(riskMultiplier, 4),
    confirmBars,
    stopBufferPct: round(stopBufferPct, 6),
    trailingMode,
    trailingRetracePct: round(trailingRetracePct, 4),
    maxHoldBars,
  };
}

/* =========================================================
PROFILE SCORING
========================================================= */

function scoreStrategyProfile(profile, candles) {
  const list = asArray(candles);
  if (list.length < 12) {
    return {
      score: 0,
      signals: 0,
      alignedSignals: 0,
      quality: "insufficient_data",
    };
  }

  let signals = 0;
  let alignedSignals = 0;
  let totalStrength = 0;

  for (let i = 6; i < list.length; i += 1) {
    const slice = list.slice(Math.max(0, i - 6), i + 1);
    const signal = detectDiscoverySignal(slice);

    if (!signal) continue;

    signals += 1;

    let strength = 1;

    if (profile.style === "reversal_precision" && profile.confirmBars >= 2) {
      strength += 0.2;
    }

    if (profile.entryMode === "CONFIRM_AFTER_STALL") {
      strength += 0.1;
    }

    if (profile.trailingMode === "TRAIL_RETRACE") {
      strength += 0.1;
    }

    if (profile.maxHoldBars <= 6) {
      strength += 0.08;
    }

    if (
      profile.confidenceThreshold >= 0.6 &&
      profile.confidenceThreshold <= 0.8
    ) {
      strength += 0.08;
    }

    if (profile.edgeThreshold >= 0.0008 && profile.edgeThreshold <= 0.0035) {
      strength += 0.08;
    }

    alignedSignals += 1;
    totalStrength += strength * safeNum(signal.confidenceBoost, 1);
  }

  const baseScore =
    signals > 0 ? (alignedSignals / signals) * (totalStrength / signals) : 0;

  const sampleBonus = Math.min(signals / 25, 1) * 0.35;
  const score = round(baseScore + sampleBonus, 6);

  return {
    score,
    signals,
    alignedSignals,
    quality:
      score >= 1.2 ? "strong" :
      score >= 0.8 ? "good" :
      score > 0 ? "weak" :
      "no_signal",
  };
}

/* =========================================================
TRAINING SAFE CALL
========================================================= */

async function runTrainingSafe({
  tenantId,
  symbol,
  candles,
  strategy,
}) {
  try {
    if (typeof trainingEngine?.runTrainingSession !== "function") {
      return {
        ok: false,
        skipped: true,
        reason: "training_engine_missing",
      };
    }

    const result = await trainingEngine.runTrainingSession({
      tenantId,
      symbol,
      candles,
      strategy,
    });

    return {
      ok: true,
      skipped: false,
      result: result || null,
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err?.message || "training_failed",
    };
  }
}

/* =========================================================
DISCOVERY
========================================================= */

async function discoverStrategy({
  tenantId,
  symbol = DEFAULT_SYMBOL,
  variants = DEFAULT_DISCOVERY_VARIANTS,
} = {}) {
  const normalizedSymbol = String(symbol || DEFAULT_SYMBOL).toUpperCase();
  const candles = getCandlesSafe(normalizedSymbol);

  const candidateCount = clamp(safeNum(variants, DEFAULT_DISCOVERY_VARIANTS), 3, 100);

  const candidates = [];

  for (let i = 0; i < candidateCount; i += 1) {
    const strategy = generateStrategyProfile();
    const scoring = scoreStrategyProfile(strategy, candles);

    candidates.push({
      strategy,
      scoring,
    });
  }

  candidates.sort((a, b) => safeNum(b?.scoring?.score, 0) - safeNum(a?.scoring?.score, 0));

  const best = candidates[0] || {
    strategy: generateStrategyProfile(),
    scoring: {
      score: 0,
      signals: 0,
      alignedSignals: 0,
      quality: "fallback",
    },
  };

  const training = await runTrainingSafe({
    tenantId,
    symbol: normalizedSymbol,
    candles,
    strategy: best.strategy,
  });

  return {
    ok: true,
    symbol: normalizedSymbol,
    discoveredAt: new Date().toISOString(),
    candlesAnalyzed: candles.length,
    strategy: best.strategy,
    discoveryScore: best.scoring,
    topCandidates: candidates.slice(0, 5),
    trainingResult: training.result || null,
    trainingMeta: {
      ok: training.ok,
      skipped: training.skipped,
      error: training.error || null,
    },
  };
}

module.exports = {
  discoverStrategy,
  generateStrategyProfile,
  detectDiscoverySignal,
  scoreStrategyProfile,
};
