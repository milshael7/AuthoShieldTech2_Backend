// backend/src/services/strategyEngine.js
// Phase 3 — Rule Engine + Adaptive Learning + Performance Feedback
// TRUE self-adjusting thresholds (per tenant)

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   BASE CONFIG (STATIC FLOOR VALUES)
   ========================================================= */

const BASE_CONFIG = Object.freeze({
  minConfidence: Number(process.env.TRADE_MIN_CONF || 0.62),
  minEdge: Number(process.env.TRADE_MIN_EDGE || 0.0007),

  baseRiskPct: Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct: Number(process.env.TRADE_MAX_RISK || 0.02),

  maxDailyTrades: Number(process.env.TRADE_MAX_TRADES_PER_DAY || 15),
});

/* =========================================================
   LEARNING MEMORY (IN-MEMORY PER PROCESS)
   Can be persisted later if needed
   ========================================================= */

const LEARNING = new Map(); // tenantId -> learning state

function getLearningState(tenantId) {
  if (!LEARNING.has(tenantId)) {
    LEARNING.set(tenantId, {
      edgeMultiplier: 1,
      confidenceMultiplier: 1,
      lastWinRate: 0.5,
      lastUpdated: Date.now(),
    });
  }
  return LEARNING.get(tenantId);
}

/* =========================================================
   EDGE MODEL
   ========================================================= */

function computeEdge(context = {}) {
  const price = Number(context.price);
  const lastPrice = Number(context.lastPrice);
  const volatility = Number(context.volatility || 0.002);

  if (!Number.isFinite(price) || !Number.isFinite(lastPrice)) {
    return 0;
  }

  const momentum = (price - lastPrice) / lastPrice;
  const normalized = momentum / (volatility || 0.001);

  return clamp(normalized, -0.02, 0.02);
}

/* =========================================================
   CONFIDENCE MODEL
   ========================================================= */

function computeConfidence(context = {}) {
  const edge = Number(context.edge || 0);
  const ticksSeen = Number(context.ticksSeen || 0);

  if (ticksSeen < 50) return 0.4;

  const base = Math.abs(edge) * 8;
  return clamp(base, 0, 1);
}

/* =========================================================
   PERFORMANCE FEEDBACK (REAL LEARNING)
   ========================================================= */

function adaptFromPerformance(tenantId, paperState) {
  if (!paperState?.trades || paperState.trades.length < 10) return;

  const learning = getLearningState(tenantId);

  const recent = paperState.trades.slice(-20);
  const wins = recent.filter(t => t.profit > 0).length;
  const losses = recent.filter(t => t.profit <= 0).length;

  const total = wins + losses;
  if (!total) return;

  const winRate = wins / total;
  learning.lastWinRate = winRate;

  // If performance degrading → tighten filters
  if (winRate < 0.45) {
    learning.edgeMultiplier = clamp(learning.edgeMultiplier * 1.1, 1, 2);
    learning.confidenceMultiplier = clamp(learning.confidenceMultiplier * 1.05, 1, 1.5);
  }

  // If performance strong → slightly relax
  if (winRate > 0.65) {
    learning.edgeMultiplier = clamp(learning.edgeMultiplier * 0.95, 0.7, 1.5);
    learning.confidenceMultiplier = clamp(learning.confidenceMultiplier * 0.97, 0.7, 1.3);
  }

  learning.lastUpdated = Date.now();
}

/* =========================================================
   RULE EVALUATION (WITH ADAPTIVE THRESHOLDS)
   ========================================================= */

function evaluateRules(ctx = {}) {
  const { price, edge, confidence, limits, tenantId, paperState } = ctx;

  const learning = getLearningState(tenantId);

  adaptFromPerformance(tenantId, paperState);

  const adaptiveMinEdge =
    BASE_CONFIG.minEdge * learning.edgeMultiplier;

  const adaptiveMinConfidence =
    BASE_CONFIG.minConfidence * learning.confidenceMultiplier;

  if (!Number.isFinite(price)) {
    return { action: "WAIT", reason: "Invalid price." };
  }

  if (limits?.halted) {
    return { action: "WAIT", reason: "Trading halted." };
  }

  if (limits?.tradesToday >= BASE_CONFIG.maxDailyTrades) {
    return { action: "WAIT", reason: "Daily trade cap reached." };
  }

  if (confidence < adaptiveMinConfidence) {
    return { action: "WAIT", reason: "Adaptive confidence filter." };
  }

  if (Math.abs(edge) < adaptiveMinEdge) {
    return { action: "WAIT", reason: "Adaptive edge filter." };
  }

  if (edge > 0) return { action: "BUY", reason: "Momentum confirmed." };
  if (edge < 0) return { action: "SELL", reason: "Momentum reversal." };

  return { action: "WAIT", reason: "No signal." };
}

/* =========================================================
   RISK MODEL
   ========================================================= */

function adjustRisk(ctx = {}) {
  const lossesToday = Number(ctx.limits?.lossesToday || 0);

  if (lossesToday >= 2) {
    return BASE_CONFIG.baseRiskPct;
  }

  return clamp(
    BASE_CONFIG.baseRiskPct * 2,
    BASE_CONFIG.baseRiskPct,
    BASE_CONFIG.maxRiskPct
  );
}

/* =========================================================
   FINAL DECISION BUILDER
   ========================================================= */

function buildDecision(context = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    price,
    lastPrice,
    volatility,
    ticksSeen = 0,
    limits = {},
    paperState = null,
  } = context;

  const edge = computeEdge({ price, lastPrice, volatility });
  const confidence = computeConfidence({ edge, ticksSeen });

  const ruleResult = evaluateRules({
    price,
    edge,
    confidence,
    limits,
    tenantId,
    paperState,
  });

  const riskPct = adjustRisk({ limits });

  return {
    symbol,
    action: ruleResult.action,
    reason: ruleResult.reason,
    confidence,
    edge,
    riskPct,
    learning: getLearningState(tenantId),
    ts: Date.now(),
  };
}

module.exports = {
  buildDecision,
};
