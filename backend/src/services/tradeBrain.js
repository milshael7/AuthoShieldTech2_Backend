// backend/src/services/tradeBrain.js
// Phase 4 — Unified Brain Layer
// Bridges paper/live trader → strategyEngine
// Fully Adaptive + Tenant Safe

const aiBrain = require("./aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ---------------- SAFETY CONSTANTS ---------------- */

const MAX_TRADES_PER_DAY = Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);
const MAX_LOSS_STREAK = Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const ALLOWED_ACTIONS = new Set(["WAIT", "BUY", "SELL", "CLOSE"]);

/* ---------------- HELPERS ---------------- */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------- CORE DECISION ---------------- */

function makeDecision(context = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    last,
    paper = {},
  } = context;

  const price = safeNum(last, NaN);
  const limits = paper.limits || {};
  const learn = paper.learnStats || {};

  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);

  /* ================= STRATEGY ENGINE ================= */

  const strategyView = buildDecision({
    tenantId,
    symbol,
    price,
    lastPrice: paper.lastPrice,
    volatility: paper.volatility,
    ticksSeen: learn.ticksSeen,
    limits,
    paperState: paper,
  });

  let action = strategyView.action;
  let confidence = strategyView.confidence;
  let edge = strategyView.edge;
  let reason = strategyView.reason;

  /* ================= AI OVERLAY (SOFT BIAS ONLY) ================= */

  try {
    if (typeof aiBrain.decide === "function") {
      const aiView = aiBrain.decide({ symbol, last, paper }) || {};

      if (
        aiView.action &&
        ALLOWED_ACTIONS.has(aiView.action.toUpperCase())
      ) {
        confidence = Math.max(confidence, safeNum(aiView.confidence, 0));
        edge = Math.max(edge, safeNum(aiView.edge, 0));
      }
    }
  } catch {}

  /* ================= HARD SAFETY GATES ================= */

  if (!Number.isFinite(price)) {
    action = "WAIT";
    reason = "Missing price.";
  } else if (limits.halted) {
    action = "WAIT";
    reason = "System halted.";
  } else if (tradesToday >= MAX_TRADES_PER_DAY) {
    action = "WAIT";
    reason = "Daily trade limit reached.";
  } else if (lossesToday >= MAX_LOSS_STREAK) {
    action = "WAIT";
    reason = "Loss streak protection.";
  }

  return {
    symbol,
    action,
    confidence: action === "WAIT" ? 0 : confidence,
    edge: action === "WAIT" ? 0 : edge,
    riskPct: strategyView.riskPct,
    reason,
    learning: strategyView.learning,
    ts: Date.now(),
  };
}

module.exports = {
  makeDecision,
};
