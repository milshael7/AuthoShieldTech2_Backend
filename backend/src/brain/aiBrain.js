// ==========================================================
// FILE: backend/src/brain/aiBrain.js
// VERSION: v3.0 (Institutional Adaptive Intelligence Core)
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
      recentPnL: [],
      aggression: 1,
    });
  }

  return LOCAL_STATE.get(key);
}

/* =========================================================
REGIME DETECTION
========================================================= */

function detectRegime(volatility, trendStrength = 0) {
  if (volatility > 0.025) return "volatile";
  if (trendStrength > 0.004) return "trend";
  if (trendStrength < 0.001) return "range";
  return "neutral";
}

/* =========================================================
LEARNING HELPERS
========================================================= */

function getSymbolEdge(symbol, brain) {
  const s = brain.symbols?.[symbol];
  if (!s || s.trades < 5) return 0;

  const winRate = s.wins / Math.max(1, s.trades);
  return clamp((winRate - 0.5) * 0.4, -0.2, 0.2);
}

function getPatternEdge(pattern, brain) {
  const p = brain.patterns?.[pattern];
  if (!p || p.trades < 5) return 0;

  const winRate = p.wins / Math.max(1, p.trades);
  return clamp((winRate - 0.5) * 0.5, -0.25, 0.25);
}

function getSetupEdge(setup, brain) {
  const s = brain.setups?.[setup];
  if (!s || s.trades < 5) return 0;

  const winRate = s.wins / Math.max(1, s.trades);
  return clamp((winRate - 0.5) * 0.6, -0.3, 0.3);
}

function computePerformanceBias(brainStats) {
  const net = safe(brainStats.netPnL, 0);
  const trades = safe(brainStats.totalTrades, 1);

  return clamp(net / (trades * 500), -0.2, 0.2);
}

/* =========================================================
RECENT MEMORY (FAST LEARNING)
========================================================= */

function updateRecentPnL(state, pnl) {
  if (!Number.isFinite(pnl)) return;

  state.recentPnL.push(pnl);

  if (state.recentPnL.length > 20) {
    state.recentPnL.shift();
  }
}

function getRecentBias(state) {
  if (!state.recentPnL.length) return 0;

  const sum = state.recentPnL.reduce((a, b) => a + b, 0);
  return clamp(sum / (state.recentPnL.length * 200), -0.15, 0.15);
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

  if (winRate > 0.65) drift += 0.06;
  if (winRate < 0.4) drift -= 0.08;

  return clamp(base + drift, 0, 1);
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

  /* ================= LEARNING LAYERS ================= */

  const symbolEdge = getSymbolEdge(symbol, brain);
  const patternEdge = getPatternEdge(pattern, brain);
  const setupEdge = getSetupEdge(setup, brain);

  const perfBias = computePerformanceBias(brain.stats);
  const recentBias = getRecentBias(state);

  state.performanceBias = perfBias;

  /* ================= CONFIDENCE ================= */

  let confidence =
    baseConfidence +
    reasoning.confidenceAdjustment +
    symbolEdge +
    patternEdge +
    setupEdge +
    perfBias +
    recentBias;

  confidence = calibrateConfidence(confidence, brain.stats);

  /* ================= EDGE ================= */

  let edge =
    baseEdge +
    reasoning.edgeAdjustment +
    symbolEdge +
    patternEdge +
    setupEdge +
    perfBias * 0.5 +
    recentBias;

  /* ================= REGIME ADAPTATION ================= */

  if (regime === "volatile") {
    confidence *= 0.82;
    edge *= 0.75;
  }

  if (regime === "range") {
    edge *= 0.7;
  }

  if (regime === "trend") {
    confidence *= 1.08;
    edge *= 1.15;
  }

  /* ================= DRAWDOWN PROTECTION ================= */

  const equity = safe(paper?.equity, 0);
  const peak = safe(paper?.peakEquity, equity);

  const drawdown =
    peak > 0 ? (peak - equity) / peak : 0;

  if (drawdown > 0.05) {
    confidence *= 0.65;
    edge *= 0.6;
  }

  /* ================= ADAPTIVE AGGRESSION ================= */

  if (recentBias > 0.05) {
    confidence *= 1.05;
    edge *= 1.05;
  }

  if (recentBias < -0.05) {
    confidence *= 0.85;
    edge *= 0.8;
  }

  /* ================= FINAL ================= */

  return {
    confidence: clamp(confidence, 0, 1),
    edge: clamp(edge, -1, 1),
    regime,
    score: reasoning.score,
    components: {
      symbolEdge,
      patternEdge,
      setupEdge,
      perfBias,
      recentBias,
    },
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
    const state = getState(tenantId);

    updateRecentPnL(state, pnl);

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
