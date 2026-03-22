// ==========================================================
// FILE: backend/src/brain/aiBrain.js
// VERSION: v3.5 (CACHED + STABLE + ADAPTIVE FIXED)
// ==========================================================

const { recordTrade, readBrain } = require("./brain.store");
const { reasonTradeContext } = require("./brain.reasoner");

/* =========================================================
CACHE (🔥 FIX)
========================================================= */

let BRAIN_CACHE = null;
let LAST_LOAD = 0;
const CACHE_TTL = 3000;

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

/* =========================================================
BRAIN LOAD (🔥 FIXED)
========================================================= */

function getBrain() {
  const now = Date.now();

  if (BRAIN_CACHE && now - LAST_LOAD < CACHE_TTL) {
    return BRAIN_CACHE;
  }

  const brain = readBrain() || {};

  if (!brain.stats) {
    brain.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      netPnL: 0,
    };
  }

  BRAIN_CACHE = brain;
  LAST_LOAD = now;

  return brain;
}

/* =========================================================
STATE
========================================================= */

function getState(id) {
  const key = String(id || "__default__");

  if (!LOCAL_STATE.has(key)) {
    LOCAL_STATE.set(key, {
      lastRegime: "neutral",
      recentPnL: [],
    });
  }

  return LOCAL_STATE.get(key);
}

/* =========================================================
REGIME
========================================================= */

function detectRegime(volatility, trendStrength = 0) {
  if (volatility > 0.025) return "volatile";
  if (trendStrength > 0.004) return "trend";
  if (trendStrength < 0.001) return "range";
  return "neutral";
}

/* =========================================================
EDGES
========================================================= */

function getEdge(bucket, scale, limit = 0.25) {
  if (!bucket || bucket.trades < 5) return 0;
  const winRate = bucket.wins / Math.max(1, bucket.trades);
  return clamp((winRate - 0.5) * scale, -limit, limit);
}

/* =========================================================
RECENT MEMORY
========================================================= */

function updateRecentPnL(state, pnl) {
  if (!Number.isFinite(pnl)) return;

  state.recentPnL.push(pnl);
  if (state.recentPnL.length > 20) state.recentPnL.shift();
}

function getRecentBias(state) {
  if (!state.recentPnL.length) return 0;

  const sum = state.recentPnL.reduce((a, b) => a + b, 0);
  return clamp(sum / (state.recentPnL.length * 200), -0.15, 0.15);
}

/* =========================================================
CONFIDENCE
========================================================= */

function calibrateConfidence(base, stats) {
  const winRate =
    stats.totalTrades > 0
      ? stats.wins / stats.totalTrades
      : 0.5;

  if (winRate > 0.65) base += 0.05;
  if (winRate < 0.4) base -= 0.08;

  return clamp(base, 0, 1);
}

/* =========================================================
DECISION ENGINE
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
  const brain = getBrain();

  const volatility = safe(paper?.volatility, 0);
  const trendStrength = Math.abs(baseEdge);

  const regime = detectRegime(volatility, trendStrength);

  /* ================= REASONING ================= */

  const reasoning = reasonTradeContext({
    symbol,
    pattern,
    setup,
    confidence: baseConfidence,
  });

  /* ================= EDGES ================= */

  const symbolEdge = getEdge(brain.symbols?.[symbol], 0.4, 0.2);
  const patternEdge = getEdge(brain.patterns?.[pattern], 0.5, 0.25);
  const setupEdge = getEdge(brain.setups?.[setup], 0.6, 0.3);

  const perfBias = clamp(
    safe(brain.stats?.netPnL) /
      Math.max(1, brain.stats.totalTrades * 500),
    -0.2,
    0.2
  );

  const recentBias = getRecentBias(state);

  /* ================= BASELINE (🔥 FIX) ================= */

  if (!baseConfidence) baseConfidence = 0.35;
  if (!baseEdge) baseEdge = 0.0003;

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

  /* ================= REGIME ================= */

  if (regime === "volatile") {
    confidence *= 0.8;
    edge *= 0.7;
  }

  if (regime === "trend") {
    confidence *= 1.08;
    edge *= 1.15;
  }

  /* ================= DRAWDOWN ================= */

  const equity = safe(paper?.equity, 0);
  const peak = safe(paper?.peakEquity, equity);

  const dd = peak > 0 ? (peak - equity) / peak : 0;

  if (dd > 0.05) {
    confidence *= 0.65;
    edge *= 0.6;
  }

  return {
    confidence: clamp(confidence, 0, 1),
    edge: clamp(edge, -1, 1),
    regime,
    score: reasoning.score,
  };
}

/* =========================================================
LEARNING
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

    // 🔥 invalidate cache
    BRAIN_CACHE = null;

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

/* ========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  resetTenant,
};
