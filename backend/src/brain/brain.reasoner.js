// ==========================================================
// FILE: backend/src/brain/brain.reasoner.js
// VERSION: v2.0 (Institutional Reasoning Engine)
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

/* =========================================================
WIN RATE / NET
========================================================= */

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
SAMPLE STRENGTH (ANTI-OVERFITTING)
========================================================= */

function getSampleStrength(trades) {
  const t = safeNum(trades, 0);

  if (t <= 0) return 0;
  if (t >= 60) return 1;

  return clamp(t / 60, 0, 1);
}

/* =========================================================
RECENT PERFORMANCE (FAST LEARNING)
========================================================= */

function getRecentPerformance(brain) {
  const history = Array.isArray(brain?.history)
    ? brain.history.slice(-30)
    : [];

  if (!history.length) return 0;

  const pnlSum = history.reduce((a, b) => a + safeNum(b.pnl, 0), 0);

  return clamp(pnlSum / (history.length * 100), -0.2, 0.2);
}

/* =========================================================
FAILURE DETECTION
========================================================= */

function detectFailureCluster(brain, setup) {
  const history = Array.isArray(brain?.history)
    ? brain.history.slice(-25)
    : [];

  if (!history.length) return 0;

  const recentSetup = history.filter((h) => h.setup === setup);

  if (recentSetup.length < 5) return 0;

  const losses = recentSetup.filter((h) => safeNum(h.pnl, 0) < 0).length;
  const lossRate = losses / recentSetup.length;

  if (lossRate > 0.7) {
    return clamp((lossRate - 0.5) * 0.3, 0, 0.2);
  }

  return 0;
}

/* =========================================================
SCORING CORE
========================================================= */

function scoreStats(stats) {
  const trades = safeNum(stats?.trades, 0);
  const winRate = safeWinRate(stats);
  const netPerTrade = safeNetPerTrade(stats);
  const strength = getSampleStrength(trades);

  const winComponent = (winRate - 0.5) * 2;
  const netComponent = clamp(netPerTrade / 40, -1, 1);

  const raw = winComponent * 0.65 + netComponent * 0.35;

  return clamp(raw * strength, -1, 1);
}

/* =========================================================
ENTITY SCORERS
========================================================= */

function scoreSymbol(symbol) {
  const stats = getSymbolStats(String(symbol || "").toUpperCase());
  return {
    score: scoreStats(stats),
    trades: safeNum(stats?.trades, 0),
    winRate: safeWinRate(stats),
  };
}

function scorePattern(pattern) {
  const stats = getPatternStats(String(pattern || "unknown"));
  return {
    score: scoreStats(stats),
    trades: safeNum(stats?.trades, 0),
    winRate: safeWinRate(stats),
  };
}

function scoreSetup(setup) {
  const stats = getSetupStats(String(setup || "unknown"));
  return {
    score: scoreStats(stats),
    trades: safeNum(stats?.trades, 0),
    winRate: safeWinRate(stats),
    avgConfidence: safeNum(stats?.avgConfidence, 0),
  };
}

/* =========================================================
MAIN REASONING
========================================================= */

function reasonTradeContext({
  symbol,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  const brain = readBrain();

  const symbolView = scoreSymbol(symbol);
  const patternView = scorePattern(pattern);
  const setupView = scoreSetup(setup);

  const recentBias = getRecentPerformance(brain);
  const failurePenalty = detectFailureCluster(brain, setup);

  /* ================= WEIGHTING ================= */

  const symbolWeight = 0.32;
  const patternWeight = 0.22;
  const setupWeight = 0.30;
  const globalWeight = 0.16;

  const globalScore = clamp(
    ((safeWinRate(brain.stats) - 0.5) * 2) * 0.7 +
      clamp(safeNum(brain.stats?.netPnL, 0) / 5000, -1, 1) * 0.3,
    -1,
    1
  );

  const compositeScore = clamp(
    symbolView.score * symbolWeight +
      patternView.score * patternWeight +
      setupView.score * setupWeight +
      globalScore * globalWeight +
      recentBias,
    -1,
    1
  );

  /* ================= CONFIDENCE ================= */

  let confidenceAdjustment = compositeScore * 0.14;

  // Overconfidence penalty
  if (
    setupView.trades >= 12 &&
    confidence > setupView.avgConfidence &&
    setupView.score < 0
  ) {
    confidenceAdjustment -= Math.abs(setupView.score) * 0.05;
  }

  // Failure cluster penalty
  confidenceAdjustment -= failurePenalty;

  /* ================= EDGE ================= */

  let edgeAdjustment = compositeScore * 0.06;

  /* ================= FINAL ================= */

  return {
    score: compositeScore,
    confidenceAdjustment: clamp(confidenceAdjustment, -0.2, 0.2),
    edgeAdjustment: clamp(edgeAdjustment, -0.08, 0.08),
    riskAdjustment: clamp(compositeScore * 0.18, -0.2, 0.2),

    diagnostics: {
      symbol: symbolView,
      pattern: patternView,
      setup: setupView,
      recentBias,
      failurePenalty,
      globalScore,
    },
  };
}

/* =========================================================
BOOST API
========================================================= */

function getReasoningBoost(params) {
  const result = reasonTradeContext(params);
  return clamp(1 + result.confidenceAdjustment, 0.8, 1.2);
}

/* =========================================================
STATUS
========================================================= */

function getReasonerStatus() {
  try {
    const brain = readBrain();
    return {
      ok: true,
      totalTrades: safeNum(brain?.stats?.totalTrades, 0),
      memoryDepth: safeNum(brain?.history?.length, 0),
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "reasoner_error",
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
