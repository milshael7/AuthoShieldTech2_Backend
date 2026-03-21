// ==========================================================
// FILE: backend/src/brain/aiBrain.js
// VERSION: v2.0 (Institutional Adaptive Intelligence Core)
// ==========================================================

const {
  recordTrade,
  readBrain,
} = require("./brain.store");

const {
  reasonTradeContext,
} = require("./brain.reasoner");

/* =========================================================
STATE
========================================================= */

const LOCAL_STATE = new Map();

/* =========================================================
UTIL
========================================================= */

function safe(n, f = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : f;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getState(id) {
  const key = String(id || "__default__");

  if (!LOCAL_STATE.has(key)) {
    LOCAL_STATE.set(key, {
      lastRegime: "neutral",
      confidenceDrift: 0,
      performanceBias: 0,
    });
  }

  return LOCAL_STATE.get(key);
}

/* =========================================================
REGIME DETECTION
========================================================= */

function detectRegime(volatility, trendStrength = 0) {
  if (volatility > 0.02) return "volatile";
  if (trendStrength > 0.003) return "trend";
  if (trendStrength < 0.001) return "range";
  return "neutral";
}

/* =========================================================
CONFIDENCE CALIBRATION
========================================================= */

function calibrateConfidence(base, brainStats) {
  const winRate =
    brainStats.totalTrades > 0
      ? brainStats.wins / brainStats.totalTrades
      : 0.5;

  let drift = 0;

  if (winRate > 0.6) drift += 0.05;
  if (winRate < 0.4) drift -= 0.05;

  return clamp(base + drift, 0, 1);
}

/* =========================================================
PERFORMANCE BIAS
========================================================= */

function computePerformanceBias(brainStats) {
  const net = safe(brainStats.netPnL, 0);
  const trades = safe(brainStats.totalTrades, 1);

  return clamp(net / (trades * 1000), -0.15, 0.15);
}

/* =========================================================
MAIN DECISION OVERLAY
========================================================= */

function decide({
  tenantId,
  symbol,
  last,
  paper,
  baseConfidence = 0,
  baseEdge = 0,
  pattern = "unknown",
  setup = "unknown",
}) {
  const state = getState(tenantId);
  const brain = readBrain();

  const volatility = safe(paper?.volatility, 0);
  const trendStrength = Math.abs(safe(baseEdge, 0));

  const regime = detectRegime(volatility, trendStrength);
  state.lastRegime = regime;

  /* ================= REASONER ================= */

  const reasoning = reasonTradeContext({
    symbol,
    pattern,
    setup,
    confidence: baseConfidence,
  });

  /* ================= PERFORMANCE ================= */

  const perfBias = computePerformanceBias(brain.stats);
  state.performanceBias = perfBias;

  /* ================= CONFIDENCE ================= */

  let confidence =
    baseConfidence +
    reasoning.confidenceAdjustment +
    perfBias;

  confidence = calibrateConfidence(confidence, brain.stats);

  /* ================= EDGE ================= */

  let edge =
    baseEdge +
    reasoning.edgeAdjustment +
    perfBias * 0.5;

  /* ================= REGIME ADAPTATION ================= */

  if (regime === "volatile") {
    confidence *= 0.85;
    edge *= 0.8;
  }

  if (regime === "range") {
    edge *= 0.75;
  }

  if (regime === "trend") {
    confidence *= 1.05;
    edge *= 1.1;
  }

  /* ================= DRAWDOWN PROTECTION ================= */

  const equity = safe(paper?.equity, 0);
  const peak = safe(paper?.peakEquity, equity);

  const drawdown =
    peak > 0 ? (peak - equity) / peak : 0;

  if (drawdown > 0.05) {
    confidence *= 0.7;
    edge *= 0.6;
  }

  /* ================= FINAL ================= */

  return {
    confidence: clamp(confidence, 0, 1),
    edge: clamp(edge, -1, 1),
    regime,
    score: reasoning.score,
  };
}

/* =========================================================
LEARNING (TRADE OUTCOME)
========================================================= */

function recordTradeOutcome({
  tenantId,
  symbol,
  pnl,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  try {
    recordTrade({
      symbol,
      pnl,
      pattern,
      setup,
      confidence,
    });

    return { ok: true };
  } catch (err) {
    console.error("AI learning error:", err.message);
    return { ok: false };
  }
}

/* =========================================================
RESET
========================================================= */

function resetTenant(tenantId) {
  LOCAL_STATE.delete(String(tenantId || "__default__"));
  return { ok: true };
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  resetTenant,
};
