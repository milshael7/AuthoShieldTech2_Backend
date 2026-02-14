// backend/src/services/tradeBrain.js
// Phase 9.5 — Institutional Cognitive Trade Core
// Strategy + AI Overlay + Confidence Smoothing
// Edge Momentum Model • Adaptive Throttling
// Deterministic • Tenant Safe

const aiBrain = require("./aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= SAFETY CONSTANTS ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.85);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.9);

const VOL_HIGH =
  Number(process.env.TRADE_VOL_HIGH || 0.02);

const ALLOWED_ACTIONS = new Set([
  "WAIT",
  "BUY",
  "SELL",
  "CLOSE",
]);

/* ================= MEMORY (Tenant Scoped) ================= */

const BRAIN_STATE = new Map();

function getBrainState(tenantId) {
  const key = tenantId || "__default__";

  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0,
      edgeMomentum: 0,
      lastAction: "WAIT",
    });
  }

  return BRAIN_STATE.get(key);
}

/* ================= HELPERS ================= */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ================= CORE DECISION ================= */

function makeDecision(context = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    last,
    paper = {},
  } = context;

  const brain = getBrainState(tenantId);

  const price = safeNum(last, NaN);
  const limits = paper.limits || {};
  const learn = paper.learnStats || {};
  const hasPosition = !!paper.position;

  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);

  const volatility = safeNum(paper.volatility, 0);

  /* ================= STRATEGY ENGINE ================= */

  const strategyView = buildDecision({
    tenantId,
    symbol,
    price,
    lastPrice: paper.lastPrice,
    volatility,
    ticksSeen: learn.ticksSeen,
    limits,
    paperState: paper,
  });

  let action = strategyView.action;
  let confidence = safeNum(strategyView.confidence, 0);
  let edge = safeNum(strategyView.edge, 0);
  let reason = strategyView.reason;

  /* ================= POSITION NORMALIZATION ================= */

  if (!hasPosition && action === "SELL") {
    action = "WAIT";
    reason = "No position to sell.";
  }

  if (hasPosition && action === "BUY") {
    action = "WAIT";
    reason = "Position already open.";
  }

  /* ================= AI OVERLAY (SOFT BOOST ONLY) ================= */

  try {
    if (typeof aiBrain.decide === "function") {
      const aiView =
        aiBrain.decide({ tenantId, symbol, last, paper }) || {};

      if (
        aiView.action &&
        ALLOWED_ACTIONS.has(
          String(aiView.action).toUpperCase()
        )
      ) {
        confidence = Math.max(
          confidence,
          safeNum(aiView.confidence, 0)
        );

        edge = Math.max(edge, safeNum(aiView.edge, 0));
      }
    }
  } catch {}

  /* ================= CONFIDENCE SMOOTHING ================= */

  brain.smoothedConfidence =
    brain.smoothedConfidence * CONFIDENCE_DECAY +
    confidence * (1 - CONFIDENCE_DECAY);

  confidence = clamp(brain.smoothedConfidence, 0, 1);

  /* ================= EDGE MOMENTUM MODEL ================= */

  brain.edgeMomentum =
    brain.edgeMomentum * EDGE_MEMORY_DECAY +
    edge * (1 - EDGE_MEMORY_DECAY);

  edge = clamp(brain.edgeMomentum, -1, 1);

  /* ================= VOLATILITY ADAPTATION ================= */

  if (volatility >= VOL_HIGH) {
    confidence *= 0.8; // reduce aggression in chaos
  }

  /* ================= HARD SAFETY GATES ================= */

  if (!Number.isFinite(price)) {
    action = "WAIT";
    reason = "Missing price.";
  }

  else if (limits.halted) {
    action = "WAIT";
    reason = "System halted.";
  }

  else if (tradesToday >= MAX_TRADES_PER_DAY) {
    action = "WAIT";
    reason = "Daily trade limit reached.";
  }

  else if (lossesToday >= MAX_LOSS_STREAK) {
    action = "WAIT";
    reason = "Loss streak protection.";
  }

  /* ================= RISK ADAPTATION ================= */

  let riskPct = safeNum(strategyView.riskPct, 0);

  if (confidence < 0.4) {
    riskPct *= 0.5;
  }

  if (confidence > 0.75) {
    riskPct *= 1.2;
  }

  riskPct = clamp(riskPct, 0.001, 0.05);

  /* ================= FINAL OUTPUT ================= */

  if (action === "WAIT") {
    confidence = 0;
    edge = 0;
  }

  brain.lastAction = action;

  return {
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    reason,
    learning: strategyView.learning,
    ts: Date.now(),
  };
}

/* ================= RESET ================= */

function resetTenant(tenantId) {
  BRAIN_STATE.delete(tenantId);
}

module.exports = {
  makeDecision,
  resetTenant,
};
