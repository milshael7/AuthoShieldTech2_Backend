// ==========================================================
// FILE: backend/src/brain/brain.service.js
// VERSION: v2.0 (Institutional AI Orchestration Layer)
// ==========================================================

const {
  readBrain,
  recordTrade,
} = require("./brain.store");

const {
  reasonTradeContext,
} = require("./brain.reasoner");

const aiBrain = require("./aiBrain");

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
DECISION ENGINE (CORE ENTRY POINT)
========================================================= */

function decide({
  tenantId,
  symbol,
  confidence = 0,
  edge = 0,
  pattern = "unknown",
  setup = "unknown",
  paper = {},
}) {
  try {
    /* ================= REASONING ================= */

    const reasoning = reasonTradeContext({
      symbol,
      pattern,
      setup,
      confidence,
    });

    /* ================= AI ADAPTIVE LAYER ================= */

    const adaptive = aiBrain.decide({
      tenantId,
      symbol,
      paper,
      baseConfidence: confidence,
      baseEdge: edge,
      pattern,
      setup,
    });

    /* ================= MERGE INTELLIGENCE ================= */

    let finalConfidence =
      safeNum(confidence, 0) +
      safeNum(reasoning.confidenceAdjustment, 0) * 0.6 +
      safeNum(adaptive.confidence, 0) * 0.4;

    let finalEdge =
      safeNum(edge, 0) +
      safeNum(reasoning.edgeAdjustment, 0) * 0.5 +
      safeNum(adaptive.edge, 0) * 0.5;

    /* ================= RISK MODULATION ================= */

    let riskAdjustment = safeNum(reasoning.riskAdjustment, 0);

    if (adaptive?.regime === "volatile") {
      riskAdjustment *= 0.7;
    }

    if (adaptive?.regime === "trend") {
      riskAdjustment *= 1.1;
    }

    /* ================= FINAL CLAMP ================= */

    finalConfidence = clamp(finalConfidence, 0, 1);
    finalEdge = clamp(finalEdge, -1, 1);

    return {
      confidence: finalConfidence,
      edge: finalEdge,
      riskAdjustment: clamp(riskAdjustment, -0.25, 0.25),

      regime: adaptive?.regime || "neutral",

      score: reasoning.score,

      diagnostics: {
        reasoning: reasoning.diagnostics,
        adaptive: adaptive.components || {},
      },
    };
  } catch (err) {
    console.error("AI decide error:", err.message);

    return {
      confidence,
      edge,
      riskAdjustment: 0,
      score: 0,
    };
  }
}

/* =========================================================
LEARNING PIPELINE (CRITICAL)
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
    /* ================= STORE MEMORY ================= */

    recordTrade({
      symbol,
      pnl,
      pattern,
      setup,
      confidence,
    });

    /* ================= ADAPTIVE LEARNING ================= */

    aiBrain.recordTradeOutcome({
      tenantId,
      symbol,
      pnl,
      pattern,
      setup,
      confidence,
    });

    return { ok: true };
  } catch (err) {
    console.error("Brain record error:", err.message);
    return { ok: false };
  }
}

/* =========================================================
ANALYTICS (DASHBOARD READY)
========================================================= */

function getBrainStats() {
  try {
    const brain = readBrain();

    const totalTrades = safeNum(brain?.stats?.totalTrades, 0);
    const wins = safeNum(brain?.stats?.wins, 0);

    return {
      totalTrades,
      wins,
      losses: safeNum(brain?.stats?.losses, 0),
      netPnL: safeNum(brain?.stats?.netPnL, 0),

      winRate:
        totalTrades > 0 ? wins / totalTrades : 0,

      symbols: brain?.symbols || {},
      patterns: brain?.patterns || {},
      setups: brain?.setups || {},

      memoryDepth: Array.isArray(brain?.history)
        ? brain.history.length
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
RESET
========================================================= */

function resetBrain() {
  try {
    return { ok: false, message: "Use brain.store reset instead" };
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
