// ==========================================================
// FILE: backend/src/brain/aiBrain.js
// VERSION: v1.0 (Adaptive Learning AI Layer)
// PURPOSE:
// - Learn from trade outcomes
// - Adjust confidence + edge dynamically
// - Provide AI overlay to tradeBrain
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
STATE
========================================================= */

const AI_STATE = new Map();

function getState(tenantId) {
  const key = String(tenantId || "__default__");

  if (!AI_STATE.has(key)) {
    AI_STATE.set(key, {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,

      symbolStats: {},

      confidenceBias: 0,
      edgeBias: 0,

      lastUpdated: Date.now(),
    });
  }

  return AI_STATE.get(key);
}

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
LEARNING ENGINE
========================================================= */

function recordTradeOutcome({
  tenantId,
  symbol,
  pnl,
}) {
  const state = getState(tenantId);

  const profit = safeNum(pnl, 0);

  state.totalTrades += 1;
  state.netPnl += profit;

  if (profit > 0) state.wins += 1;
  else state.losses += 1;

  const sym = String(symbol || "UNKNOWN").toUpperCase();

  if (!state.symbolStats[sym]) {
    state.symbolStats[sym] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
    };
  }

  const s = state.symbolStats[sym];

  s.trades += 1;
  s.net += profit;

  if (profit > 0) s.wins += 1;
  else s.losses += 1;

  /* ================= ADAPTATION ================= */

  const winRate =
    state.totalTrades > 0 ? state.wins / state.totalTrades : 0.5;

  const symbolWinRate =
    s.trades > 0 ? s.wins / s.trades : 0.5;

  // 🔥 Adjust confidence bias
  state.confidenceBias = clamp(
    (winRate - 0.5) * 0.6 + (symbolWinRate - 0.5) * 0.4,
    -0.25,
    0.25
  );

  // 🔥 Adjust edge bias
  state.edgeBias = clamp(
    state.netPnl / Math.max(1, state.totalTrades * 1000),
    -0.15,
    0.15
  );

  state.lastUpdated = Date.now();
}

/* =========================================================
AI DECISION OVERLAY
========================================================= */

function decide({
  tenantId,
  symbol,
  last,
  paper,
}) {
  const state = getState(tenantId);

  const sym = String(symbol || "UNKNOWN").toUpperCase();
  const symStats = state.symbolStats[sym] || null;

  let confidenceBoost = 0;
  let edgeBoost = 0;

  /* ================= GLOBAL PERFORMANCE ================= */

  const globalWinRate =
    state.totalTrades > 0
      ? state.wins / state.totalTrades
      : 0.5;

  if (globalWinRate > 0.55) {
    confidenceBoost += 0.05;
    edgeBoost += 0.02;
  }

  if (globalWinRate < 0.45) {
    confidenceBoost -= 0.05;
    edgeBoost -= 0.02;
  }

  /* ================= SYMBOL PERFORMANCE ================= */

  if (symStats && symStats.trades > 5) {
    const winRate = symStats.wins / symStats.trades;

    if (winRate > 0.6) {
      confidenceBoost += 0.06;
      edgeBoost += 0.025;
    }

    if (winRate < 0.4) {
      confidenceBoost -= 0.06;
      edgeBoost -= 0.025;
    }
  }

  /* ================= DRAW DOWN PROTECTION ================= */

  const equity = safeNum(
    paper?.equity,
    safeNum(paper?.cashBalance, 0)
  );

  const peak = safeNum(paper?.peakEquity, equity);

  const drawdown =
    peak > 0 ? (peak - equity) / peak : 0;

  if (drawdown > 0.05) {
    confidenceBoost *= 0.6;
    edgeBoost *= 0.5;
  }

  /* ================= FINAL OUTPUT ================= */

  const finalConfidence = clamp(
    confidenceBoost + state.confidenceBias,
    -0.3,
    0.3
  );

  const finalEdge = clamp(
    edgeBoost + state.edgeBias,
    -0.2,
    0.2
  );

  return {
    confidence: finalConfidence,
    edge: finalEdge,
  };
}

/* =========================================================
RESET
========================================================= */

function resetTenant(tenantId) {
  const key = String(tenantId || "__default__");
  AI_STATE.delete(key);

  return { ok: true, tenantId: key };
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  resetTenant,
};
