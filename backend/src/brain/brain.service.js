// ==========================================================
// FILE: backend/src/brain/brain.service.js
// VERSION: v1.0 (Central AI Brain Service)
// PURPOSE:
// - Main interface for AI brain
// - Connect memory + reasoning
// - Provide decision support
// - Record outcomes for learning
// ==========================================================

const {
  readBrain,
  writeBrain,
} = require("./brain.store");

const {
  reasonTradeContext,
} = require("./brain.reasoner");

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
DECISION SUPPORT (USED BY tradeBrain)
========================================================= */

function decide({
  tenantId,
  symbol,
  confidence = 0,
  edge = 0,
  pattern = "unknown",
  setup = "unknown",
}) {
  try {
    const reasoning = reasonTradeContext({
      symbol,
      pattern,
      setup,
      confidence,
    });

    // Apply adjustments
    const adjustedConfidence = clamp(
      safeNum(confidence, 0) + safeNum(reasoning.confidenceAdjustment, 0),
      0,
      1
    );

    const adjustedEdge = clamp(
      safeNum(edge, 0) + safeNum(reasoning.edgeAdjustment, 0),
      -1,
      1
    );

    return {
      confidence: adjustedConfidence,
      edge: adjustedEdge,
      score: reasoning.score,
      diagnostics: reasoning.diagnostics,
    };
  } catch (err) {
    return {
      confidence: confidence,
      edge: edge,
      score: 0,
    };
  }
}

/* =========================================================
RECORD TRADE OUTCOME (USED BY executionEngine)
========================================================= */

function recordTradeOutcome({
  tenantId,
  symbol,
  pnl = 0,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  try {
    const brain = readBrain();

    /* ================= GLOBAL STATS ================= */

    brain.stats.totalTrades += 1;

    if (pnl > 0) {
      brain.stats.wins += 1;
      brain.stats.totalWinUSD += pnl;
    } else {
      brain.stats.losses += 1;
      brain.stats.totalLossUSD += pnl;
    }

    brain.stats.netPnL += pnl;

    /* ================= HISTORY ================= */

    brain.history.push({
      ts: Date.now(),
      symbol,
      pnl,
      pattern,
      setup,
      confidence,
    });

    if (brain.history.length > 1000) {
      brain.history = brain.history.slice(-1000);
    }

    writeBrain(brain);

    return { ok: true };
  } catch (err) {
    console.error("Brain record error:", err.message);
    return { ok: false };
  }
}

/* =========================================================
LIGHTWEIGHT ANALYTICS
========================================================= */

function getBrainStats() {
  try {
    const brain = readBrain();

    return {
      totalTrades: safeNum(brain?.stats?.totalTrades, 0),
      wins: safeNum(brain?.stats?.wins, 0),
      losses: safeNum(brain?.stats?.losses, 0),
      netPnL: safeNum(brain?.stats?.netPnL, 0),
      winRate:
        brain?.stats?.totalTrades > 0
          ? brain.stats.wins / brain.stats.totalTrades
          : 0,
      lastUpdated: brain?.lastUpdated || null,
    };
  } catch {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      netPnL: 0,
      winRate: 0,
    };
  }
}

/* =========================================================
RESET (OPTIONAL)
========================================================= */

function resetBrain() {
  try {
    writeBrain({
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalWinUSD: 0,
        totalLossUSD: 0,
        netPnL: 0,
        maxBalance: 0,
      },
      history: [],
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  getBrainStats,
  resetBrain,
};
