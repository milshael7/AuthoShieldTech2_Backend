// backend/src/services/strategyEngine.js
// Hybrid Strategy Engine (Rule-Based + Learning Adaptive Core)
// Phase 1 Foundation — Deterministic, Expandable, Safe

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const DEFAULT_CONFIG = Object.freeze({
  minConfidence: Number(process.env.TRADE_MIN_CONF || 0.60),
  minEdge: Number(process.env.TRADE_MIN_EDGE || 0.0005),
  maxRiskPct: Number(process.env.TRADE_MAX_RISK || 0.02),
  baseRiskPct: Number(process.env.TRADE_BASE_RISK || 0.01),
  maxDailyTrades: Number(process.env.TRADE_MAX_TRADES_PER_DAY || 15),
  cooldownMs: Number(process.env.TRADE_COOLDOWN_MS || 10000),
});

/* =========================================================
   RULE LAYER (DETERMINISTIC)
   ========================================================= */

function evaluateRules(ctx = {}) {
  const { price, edge, confidence, limits } = ctx;

  if (!Number.isFinite(price)) {
    return { action: "WAIT", reason: "Invalid price." };
  }

  if (limits?.halted) {
    return { action: "WAIT", reason: "Trading halted." };
  }

  if (confidence < DEFAULT_CONFIG.minConfidence) {
    return { action: "WAIT", reason: "Low confidence." };
  }

  if (Math.abs(edge) < DEFAULT_CONFIG.minEdge) {
    return { action: "WAIT", reason: "Edge too small." };
  }

  if (edge > 0) return { action: "BUY", reason: "Positive edge." };
  if (edge < 0) return { action: "SELL", reason: "Negative edge." };

  return { action: "WAIT", reason: "No signal." };
}

/* =========================================================
   LEARNING LAYER (ADAPTIVE ADJUSTMENTS)
   ========================================================= */

function adjustRisk(ctx = {}) {
  const lossesToday = Number(ctx.limits?.lossesToday || 0);

  if (lossesToday >= 2) {
    return DEFAULT_CONFIG.baseRiskPct;
  }

  return clamp(
    DEFAULT_CONFIG.baseRiskPct * 2,
    DEFAULT_CONFIG.baseRiskPct,
    DEFAULT_CONFIG.maxRiskPct
  );
}

/* =========================================================
   FINAL DECISION BUILDER
   ========================================================= */

function buildDecision(context = {}) {
  const {
    symbol = "BTCUSDT",
    price,
    edge = 0,
    confidence = 0,
    limits = {},
  } = context;

  const ruleResult = evaluateRules({
    price,
    edge,
    confidence,
    limits,
  });

  const riskPct = adjustRisk({ limits });

  return {
    symbol,
    action: ruleResult.action,
    reason: ruleResult.reason,
    confidence,
    edge,
    riskPct,
    ts: Date.now(),
  };
}

module.exports = {
  buildDecision,
};
