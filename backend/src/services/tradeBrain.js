// backend/src/services/tradeBrain.js
// Phase 10.5 — Adaptive Behavioral Trade Core
// Self-Learning + Streak Intelligence + Aggression Control
// Unified Memory (Paper + Live Shared)
// Deterministic • Tenant Safe • Behavioral Feedback Engine

const aiBrain = require("./aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= SAFETY CONSTANTS ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.82);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.88);

const VOL_HIGH =
  Number(process.env.TRADE_VOL_HIGH || 0.02);

const MAX_RISK = 0.06;
const MIN_RISK = 0.001;

const ALLOWED_ACTIONS = new Set([
  "WAIT",
  "BUY",
  "SELL",
  "CLOSE",
]);

/* ================= BEHAVIORAL MEMORY ================= */

const BRAIN_STATE = new Map();

function getBrainState(tenantId) {
  const key = tenantId || "__default__";

  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0,
      edgeMomentum: 0,
      lastAction: "WAIT",

      winStreak: 0,
      lossStreak: 0,
      lastRealizedNet: 0,

      aggressionFactor: 1,
      recoveryMode: false,
      calmMode: false,
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

/* ================= PERFORMANCE TRACKER ================= */

function updatePerformance(brain, paper) {
  const realizedNet = safeNum(paper?.realized?.net, 0);

  const delta = realizedNet - brain.lastRealizedNet;

  if (delta > 0) {
    brain.winStreak++;
    brain.lossStreak = 0;
    brain.recoveryMode = false;
  }

  else if (delta < 0) {
    brain.lossStreak++;
    brain.winStreak = 0;
  }

  brain.lastRealizedNet = realizedNet;

  /* Aggression scaling */

  if (brain.winStreak >= 2) {
    brain.aggressionFactor = clamp(
      brain.aggressionFactor + 0.1,
      1,
      1.6
    );
  }

  if (brain.lossStreak >= 2) {
    brain.aggressionFactor = clamp(
      brain.aggressionFactor * 0.7,
      0.5,
      1
    );
    brain.recoveryMode = true;
  }

  if (brain.lossStreak >= MAX_LOSS_STREAK) {
    brain.calmMode = true;
  }

  if (brain.winStreak >= 3) {
    brain.calmMode = true; // lock profit discipline
  }
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

  updatePerformance(brain, paper);

  const price = safeNum(last, NaN);
  const limits = paper.limits || {};
  const learn = paper.learnStats || {};
  const hasPosition = !!paper.position;

  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);
  const volatility = safeNum(paper.volatility, 0);

  /* ================= STRATEGY BASE ================= */

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

  /* ================= AI OVERLAY ================= */

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

  /* ================= SMOOTHING ================= */

  brain.smoothedConfidence =
    brain.smoothedConfidence * CONFIDENCE_DECAY +
    confidence * (1 - CONFIDENCE_DECAY);

  confidence = clamp(brain.smoothedConfidence, 0, 1);

  brain.edgeMomentum =
    brain.edgeMomentum * EDGE_MEMORY_DECAY +
    edge * (1 - EDGE_MEMORY_DECAY);

  edge = clamp(brain.edgeMomentum, -1, 1);

  /* ================= VOLATILITY DISCIPLINE ================= */

  if (volatility >= VOL_HIGH) {
    confidence *= 0.75;
    brain.calmMode = true;
  }

  /* ================= HARD SAFETY ================= */

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

  /* ================= BEHAVIORAL ADAPTATION ================= */

  let riskPct = safeNum(strategyView.riskPct, 0);

  riskPct *= brain.aggressionFactor;

  if (brain.calmMode) {
    riskPct *= 0.6;
  }

  if (brain.recoveryMode) {
    riskPct *= 0.8;
  }

  if (confidence < 0.4) {
    riskPct *= 0.5;
  }

  if (confidence > 0.8) {
    riskPct *= 1.3;
  }

  riskPct = clamp(riskPct, MIN_RISK, MAX_RISK);

  /* ================= FINAL SANITY ================= */

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
    behavioral: {
      winStreak: brain.winStreak,
      lossStreak: brain.lossStreak,
      aggressionFactor: brain.aggressionFactor,
      recoveryMode: brain.recoveryMode,
      calmMode: brain.calmMode,
    },
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
