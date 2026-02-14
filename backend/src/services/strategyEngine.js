// backend/src/services/strategyEngine.js
// Hybrid Strategy Engine (Rule-Based + Adaptive Learning Core)
// Phase 2 — Edge Model + Confidence Model + Risk Intelligence

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
   ========================================================= */

const CONFIG = Object.freeze({
  minConfidence: Number(process.env.TRADE_MIN_CONF || 0.62),
  minEdge: Number(process.env.TRADE_MIN_EDGE || 0.0007),

  baseRiskPct: Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct: Number(process.env.TRADE_MAX_RISK || 0.02),

  maxDailyTrades: Number(process.env.TRADE_MAX_TRADES_PER_DAY || 15),
  cooldownMs: Number(process.env.TRADE_COOLDOWN_MS || 10000),
});

/* =========================================================
   EDGE MODEL
   Computes directional bias using momentum + volatility
   ========================================================= */

function computeEdge(context = {}) {
  const price = Number(context.price);
  const lastPrice = Number(context.lastPrice);
  const volatility = Number(context.volatility || 0.002);

  if (!Number.isFinite(price) || !Number.isFinite(lastPrice)) {
    return 0;
  }

  const momentum = (price - lastPrice) / lastPrice;

  // normalize by volatility to avoid overreaction
  const normalized = momentum / (volatility || 0.001);

  return clamp(normalized, -0.02, 0.02);
}

/* =========================================================
   CONFIDENCE MODEL
   Confidence increases with clean trend structure
   ========================================================= */

function computeConfidence(context = {}) {
  const edge = Number(context.edge || 0);
  const ticksSeen = Number(context.ticksSeen || 0);

  if (ticksSeen < 50) return 0.4;

  const base = Math.abs(edge) * 8;
  return clamp(base, 0, 1);
}

/* =========================================================
   RULE LAYER
   ========================================================= */

function evaluateRules(ctx = {}) {
  const { price, edge, confidence, limits } = ctx;

  if (!Number.isFinite(price)) {
    return { action: "WAIT", reason: "Invalid price." };
  }

  if (limits?.halted) {
    return { action: "WAIT", reason: "Trading halted." };
  }

  if (limits?.tradesToday >= CONFIG.maxDailyTrades) {
    return { action: "WAIT", reason: "Daily trade cap reached." };
  }

  if (confidence < CONFIG.minConfidence) {
    return { action: "WAIT", reason: "Low confidence." };
  }

  if (Math.abs(edge) < CONFIG.minEdge) {
    return { action: "WAIT", reason: "Edge too small." };
  }

  if (edge > 0) return { action: "BUY", reason: "Positive momentum edge." };
  if (edge < 0) return { action: "SELL", reason: "Negative momentum edge." };

  return { action: "WAIT", reason: "No signal." };
}

/* =========================================================
   ADAPTIVE RISK CONTROL
   ========================================================= */

function adjustRisk(ctx = {}) {
  const lossesToday = Number(ctx.limits?.lossesToday || 0);

  if (lossesToday >= 2) {
    return CONFIG.baseRiskPct;
  }

  return clamp(
    CONFIG.baseRiskPct * 2,
    CONFIG.baseRiskPct,
    CONFIG.maxRiskPct
  );
}

/* =========================================================
   FINAL DECISION BUILDER
   ========================================================= */

function buildDecision(context = {}) {
  const {
    symbol = "BTCUSDT",
    price,
    lastPrice,
    volatility,
    ticksSeen = 0,
    limits = {},
  } = context;

  const edge = computeEdge({ price, lastPrice, volatility });
  const confidence = computeConfidence({ edge, ticksSeen });

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
