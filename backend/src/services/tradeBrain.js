// backend/src/services/tradeBrain.js
// PHASE 1 UPGRADE — Rule Engine + Strategy Engine + Adaptive Hooks

const aiBrain = require("./aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ---------------- SAFETY CONSTANTS ---------------- */

const BASE_MIN_CONF = Number(process.env.TRADE_MIN_CONF || 0.62);
const BASE_MIN_EDGE = Number(process.env.TRADE_MIN_EDGE || 0.0007);
const MAX_TRADES_PER_DAY = Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);
const MAX_LOSS_STREAK = Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const ALLOWED_ACTIONS = new Set(["WAIT", "BUY", "SELL", "CLOSE"]);

/* ---------------- HELPERS ---------------- */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ---------------- CORE DECISION ---------------- */

function makeDecision(context = {}) {
  const symbol = String(context.symbol || "BTCUSDT");
  const last = safeNum(context.last, NaN);

  const paper = context.paper || {};
  const learn = paper.learnStats || {};
  const limits = paper.limits || {};
  const config = paper.config || {};

  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);

  /* ---------------- ADAPTIVE THRESHOLDS ---------------- */

  const dynamicMinConf =
    lossesToday >= 2 ? BASE_MIN_CONF + 0.05 : BASE_MIN_CONF;

  const dynamicMinEdge =
    lossesToday >= 2 ? BASE_MIN_EDGE * 1.4 : BASE_MIN_EDGE;

  /* ---------------- STRATEGY ENGINE (RULE BASED CORE) ---------------- */

  const strategyView = buildDecision({
    symbol,
    price: last,
    edge: learn.trendEdge || 0,
    confidence: learn.confidence || 0,
    limits,
  });

  let action = strategyView.action;
  let confidence = strategyView.confidence;
  let edge = strategyView.edge;
  let blockedReason = "";

  /* ---------------- AI OVERLAY (SOFT) ---------------- */

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

  /* ---------------- HARD SAFETY GATES ---------------- */

  if (!Number.isFinite(last)) {
    action = "WAIT";
    blockedReason = "Missing price.";
  } else if (limits.halted) {
    action = "WAIT";
    blockedReason = "System halted.";
  } else if (tradesToday >= MAX_TRADES_PER_DAY) {
    action = "WAIT";
    blockedReason = "Daily trade limit reached.";
  } else if (lossesToday >= MAX_LOSS_STREAK) {
    action = "WAIT";
    blockedReason = "Loss streak protection.";
  } else if (confidence < dynamicMinConf) {
    action = "WAIT";
    blockedReason = "Confidence below adaptive threshold.";
  } else if (Math.abs(edge) < dynamicMinEdge) {
    action = "WAIT";
    blockedReason = "Edge below adaptive threshold.";
  }

  /* ---------------- RISK MODEL ---------------- */

  const baselinePct = clamp(
    safeNum(config.baselinePct, 0.01),
    0.001,
    0.02
  );

  const maxPct = clamp(
    safeNum(config.maxPct, 0.03),
    baselinePct,
    0.05
  );

  const riskPct =
    lossesToday >= 2
      ? baselinePct
      : clamp(baselinePct * 2, baselinePct, maxPct);

  const slPct = clamp(
    safeNum(config.slPct, 0.005),
    0.002,
    0.02
  );

  const tpPct = clamp(
    safeNum(config.tpPct, 0.01),
    slPct,
    0.05
  );

  return {
    symbol,
    action,
    confidence: action === "WAIT" ? 0 : confidence,
    edge: action === "WAIT" ? 0 : edge,
    riskPct,
    slPct,
    tpPct,
    blockedReason,
    ts: Date.now(),
  };
}

module.exports = {
  makeDecision,
};
