// ==========================================================
// FILE: backend/src/brain/brain.reasoner.js
// VERSION: v1.0 (Adaptive Reasoning Layer)
// PURPOSE:
// - Read persistent brain memory
// - Score symbols / patterns / setups
// - Provide safe confidence + edge adjustments
// - Help AI adapt over time without over-tightening
//
// RULES:
// 1. This file does NOT place trades
// 2. This file does NOT execute orders
// 3. This file only reasons over stored memory
// 4. Sparse data must produce weak adjustments, not strong ones
// ==========================================================

const {
  readBrain,
  getSymbolStats,
  getPatternStats,
  getSetupStats,
} = require("./brain.store");

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

function safeWinRate(stats) {
  const trades = safeNum(stats?.trades, 0);
  const wins = safeNum(stats?.wins, 0);

  if (trades <= 0) return 0.5;
  return clamp(wins / trades, 0, 1);
}

function safeNetPerTrade(stats) {
  const trades = safeNum(stats?.trades, 0);
  const net = safeNum(stats?.net, 0);

  if (trades <= 0) return 0;
  return net / trades;
}

/* =========================================================
SAMPLE STRENGTH
---------------------------------------------------------
Small sample sizes should not dominate the system.
========================================================= */

function getSampleStrength(trades) {
  const t = safeNum(trades, 0);

  if (t <= 0) return 0;
  if (t >= 50) return 1;

  return clamp(t / 50, 0, 1);
}

/* =========================================================
GLOBAL MEMORY VIEW
========================================================= */

function getGlobalStats() {
  try {
    const brain = readBrain();
    return brain?.stats || null;
  } catch {
    return null;
  }
}

function getGlobalWinRate() {
  const stats = getGlobalStats();
  const totalTrades = safeNum(stats?.totalTrades, 0);
  const wins = safeNum(stats?.wins, 0);

  if (totalTrades <= 0) return 0.5;
  return clamp(wins / totalTrades, 0, 1);
}

function getGlobalNetPerTrade() {
  const stats = getGlobalStats();
  const totalTrades = safeNum(stats?.totalTrades, 0);
  const netPnL = safeNum(stats?.netPnL, 0);

  if (totalTrades <= 0) return 0;
  return netPnL / totalTrades;
}

/* =========================================================
CORE SCORERS
========================================================= */

function scoreStats(stats) {
  const trades = safeNum(stats?.trades, 0);
  const winRate = safeWinRate(stats);
  const netPerTrade = safeNetPerTrade(stats);
  const strength = getSampleStrength(trades);

  // Win rate contribution: centered around 50%
  const winComponent = (winRate - 0.5) * 2; // -1 to +1

  // Net contribution: softly normalized
  const netComponent = clamp(netPerTrade / 50, -1, 1);

  // Weighted blend
  const raw = winComponent * 0.65 + netComponent * 0.35;

  // Sparse data weakens influence
  return clamp(raw * strength, -1, 1);
}

function scoreSymbol(symbol) {
  try {
    const stats = getSymbolStats(String(symbol || "").toUpperCase());
    return {
      score: scoreStats(stats),
      trades: safeNum(stats?.trades, 0),
      winRate: safeWinRate(stats),
      netPerTrade: safeNetPerTrade(stats),
    };
  } catch {
    return {
      score: 0,
      trades: 0,
      winRate: 0.5,
      netPerTrade: 0,
    };
  }
}

function scorePattern(pattern) {
  try {
    const stats = getPatternStats(String(pattern || "unknown"));
    return {
      score: scoreStats(stats),
      trades: safeNum(stats?.trades, 0),
      winRate: safeWinRate(stats),
      netPerTrade: safeNetPerTrade(stats),
    };
  } catch {
    return {
      score: 0,
      trades: 0,
      winRate: 0.5,
      netPerTrade: 0,
    };
  }
}

function scoreSetup(setup) {
  try {
    const stats = getSetupStats(String(setup || "unknown"));
    return {
      score: scoreStats(stats),
      trades: safeNum(stats?.trades, 0),
      winRate: safeWinRate(stats),
      netPerTrade: safeNetPerTrade(stats),
      avgConfidence: safeNum(stats?.avgConfidence, 0),
    };
  } catch {
    return {
      score: 0,
      trades: 0,
      winRate: 0.5,
      netPerTrade: 0,
      avgConfidence: 0,
    };
  }
}

/* =========================================================
REASONING OUTPUT
---------------------------------------------------------
This is the main function other modules should use.
It returns soft boosts/penalties, not hard commands.
========================================================= */

function reasonTradeContext({
  symbol,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  const globalWinRate = getGlobalWinRate();
  const globalNetPerTrade = getGlobalNetPerTrade();

  const symbolView = scoreSymbol(symbol);
  const patternView = scorePattern(pattern);
  const setupView = scoreSetup(setup);

  // Global score
  const globalScore = clamp(
    ((globalWinRate - 0.5) * 2) * 0.7 +
      clamp(globalNetPerTrade / 50, -1, 1) * 0.3,
    -1,
    1
  );

  // Final blended score
  const compositeScore = clamp(
    globalScore * 0.25 +
      symbolView.score * 0.30 +
      patternView.score * 0.20 +
      setupView.score * 0.25,
    -1,
    1
  );

  // Confidence boost is deliberately soft
  const confidenceAdjustment = clamp(compositeScore * 0.12, -0.12, 0.12);

  // Edge boost is a bit smaller than confidence
  const edgeAdjustment = clamp(compositeScore * 0.05, -0.05, 0.05);

  // Risk adjustment remains conservative
  const riskAdjustment = clamp(compositeScore * 0.15, -0.15, 0.15);

  // If setup historically underperforms at similar confidence, dampen it
  let confidencePenalty = 0;
  if (
    setupView.trades >= 10 &&
    safeNum(setupView.avgConfidence, 0) > 0 &&
    confidence >= setupView.avgConfidence &&
    setupView.score < 0
  ) {
    confidencePenalty = Math.abs(setupView.score) * 0.04;
  }

  return {
    score: compositeScore,
    confidenceAdjustment: clamp(
      confidenceAdjustment - confidencePenalty,
      -0.15,
      0.15
    ),
    edgeAdjustment,
    riskAdjustment,
    diagnostics: {
      global: {
        winRate: globalWinRate,
        netPerTrade: globalNetPerTrade,
        score: globalScore,
      },
      symbol: symbolView,
      pattern: patternView,
      setup: setupView,
    },
  };
}

/* =========================================================
SIMPLE BOOST API
---------------------------------------------------------
For older modules that only want a quick multiplier.
========================================================= */

function getReasoningBoost({
  symbol,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  const result = reasonTradeContext({
    symbol,
    pattern,
    setup,
    confidence,
  });

  return clamp(1 + result.confidenceAdjustment, 0.85, 1.15);
}

/* =========================================================
HEALTH CHECK
========================================================= */

function getReasonerStatus() {
  try {
    const brain = readBrain();
    return {
      ok: true,
      totalTrades: safeNum(brain?.stats?.totalTrades, 0),
      lastUpdated: safeNum(brain?.lastUpdated, 0),
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "reasoner_unavailable",
    };
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  reasonTradeContext,
  getReasoningBoost,
  getReasonerStatus,
  scoreSymbol,
  scorePattern,
  scoreSetup,
};
