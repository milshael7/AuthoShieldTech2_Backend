// -----------------------------------------------------------
// FILE: backend/src/services/tradeBrain.js
// VERSION: v25.0 (Adaptive Timing + Market Regime + Learning Enhanced)
// -----------------------------------------------------------

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY = Number(process.env.TRADE_MAX_TRADES_PER_DAY || 120);
const MAX_LOSS_STREAK = Number(process.env.TRADE_MAX_LOSS_STREAK || 4);
const MAX_DRAWDOWN = Number(process.env.TRADE_MAX_DRAWDOWN || 0.08);
const VOLATILITY_SHUTDOWN = Number(process.env.TRADE_VOLATILITY_SHUTDOWN || 0.04);

const CONFIDENCE_DECAY = Number(process.env.TRADE_CONFIDENCE_DECAY || 0.42);
const EDGE_MEMORY_DECAY = Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.52);

const MIN_CONFIDENCE_TO_TRADE = Number(process.env.TRADE_MIN_CONFIDENCE || 0.46);
const MIN_RISK = Number(process.env.TRADE_MIN_RISK || 0.0015);
const MAX_RISK = Number(process.env.TRADE_MAX_RISK || 0.06);

const TRADE_COOLDOWN_MS = Number(process.env.TRADE_COOLDOWN_MS || 6000);
const MIN_MOMENTUM_EDGE = Number(process.env.TRADE_MIN_EDGE || 0.00012);

const EXPLORATION_RATE = Number(process.env.TRADE_EXPLORATION_RATE || 0.08);

/* ================= STATE ================= */

const BRAIN_STATE = new Map();

function normalizeTenantKey(id) {
  return String(id || "__default__");
}

function getBrainState(id) {
  const key = normalizeTenantKey(id);

  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.3,
      edgeMomentum: 0,
      lastTradeTime: 0,
      priceMemory: [],
      lossStreak: 0,
      peakEquity: 0,

      // NEW
      avgWinDuration: 120000,
      avgLossDuration: 90000,
      lastTradeDuration: 0,
      regime: "UNKNOWN",
    });
  }

  return BRAIN_STATE.get(key);
}

/* ================= UTILS ================= */

const safeNum = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* ================= PRICE MEMORY ================= */

function updatePriceMemory(brain, price) {
  brain.priceMemory.push(price);
  if (brain.priceMemory.length > 100) brain.priceMemory.shift();
}

/* ================= MARKET REGIME ================= */

function detectMarketRegime(prices) {
  if (prices.length < 20) return "UNKNOWN";

  const start = prices[prices.length - 20];
  const end = prices[prices.length - 1];

  const move = (end - start) / start;

  if (Math.abs(move) < 0.002) return "CHOP";
  if (move > 0) return "UPTREND";
  if (move < 0) return "DOWNTREND";

  return "UNKNOWN";
}

/* ================= TIMING INTELLIGENCE ================= */

function estimateTradeDuration(brain, confidence, volatility) {
  let base = 120000; // 2 min baseline

  if (brain.regime === "CHOP") base *= 0.7;
  if (brain.regime === "UPTREND" || brain.regime === "DOWNTREND") base *= 1.3;

  base *= 1 + (1 - confidence);
  base *= 1 + volatility * 2;

  return clamp(base, 30000, 900000); // 30s → 15m
}

/* ================= AI OVERLAY ================= */

function getAiOverlay({ tenantId, symbol, last, paper }) {
  try {
    const ai = aiBrain.decide({ tenantId, symbol, last, paper }) || {};
    return {
      confidence: safeNum(ai.confidence, 0),
      edge: safeNum(ai.edge, 0),
    };
  } catch {
    return { confidence: 0, edge: 0 };
  }
}

/* ================= DECISION ================= */

function makeDecision(context = {}) {
  const { tenantId, symbol = "BTCUSDT", last, paper = {} } = context;

  const brain = getBrainState(tenantId);
  const price = safeNum(last, NaN);
  const now = Date.now();

  if (!Number.isFinite(price) || price <= 0) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  updatePriceMemory(brain, price);

  const prices = brain.priceMemory;
  const volatility = safeNum(paper?.volatility, 0);

  // 🔥 NEW: Market regime awareness
  brain.regime = detectMarketRegime(prices);

  let strategy = {};
  try {
    strategy = buildDecision({
      tenantId,
      symbol,
      price,
      volatility,
      paperState: paper,
    }) || {};
  } catch {}

  let action = strategy.action || "WAIT";
  let confidence = safeNum(strategy.confidence, 0.3);
  let edge = safeNum(strategy.edge, 0);
  let riskPct = safeNum(strategy.riskPct, 0.01);

  // 🔥 AI Overlay
  const ai = getAiOverlay({ tenantId, symbol, last, paper });

  confidence = clamp(confidence * 0.85 + ai.confidence * 0.15, 0, 1);
  edge = clamp(edge * 0.85 + ai.edge * 0.15, -1, 1);

  // 🔥 Smoothing
  brain.smoothedConfidence =
    brain.smoothedConfidence * CONFIDENCE_DECAY +
    confidence * (1 - CONFIDENCE_DECAY);

  confidence = clamp(brain.smoothedConfidence, 0, 1);

  brain.edgeMomentum =
    brain.edgeMomentum * EDGE_MEMORY_DECAY +
    edge * (1 - EDGE_MEMORY_DECAY);

  edge = clamp(brain.edgeMomentum, -1, 1);

  // 🔥 Exploration (controlled learning)
  if (
    action === "WAIT" &&
    Math.random() < EXPLORATION_RATE &&
    Math.abs(edge) > MIN_MOMENTUM_EDGE
  ) {
    action = edge > 0 ? "BUY" : "SELL";
    confidence *= 0.75;
    riskPct *= 0.5;
  }

  // 🔥 Confidence filter
  if ((action === "BUY" || action === "SELL") && confidence < MIN_CONFIDENCE_TO_TRADE) {
    action = "WAIT";
  }

  // 🔥 Timing intelligence (NEW CORE FEATURE)
  const expectedDuration = estimateTradeDuration(brain, confidence, volatility);

  // 🔥 Risk shaping
  if (confidence > 0.9) riskPct *= 1.4;
  else if (confidence < 0.4) riskPct *= 0.7;

  riskPct = clamp(riskPct, MIN_RISK, MAX_RISK);

  // 🔥 Cooldown
  if (now - brain.lastTradeTime < TRADE_COOLDOWN_MS) {
    if (action === "BUY" || action === "SELL") action = "WAIT";
  }

  if (action === "BUY" || action === "SELL") {
    brain.lastTradeTime = now;
  }

  return {
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    expectedDuration, // 🔥 NEW
    regime: brain.regime, // 🔥 NEW
    reason: strategy.reason || "AI_DECISION",
    ts: now,
  };
}

/* ================= LEARNING ================= */

function recordTradeOutcome({ tenantId, pnl, duration }) {
  const brain = getBrainState(tenantId);

  if (pnl > 0) {
    brain.lossStreak = 0;
    brain.avgWinDuration =
      brain.avgWinDuration * 0.8 + safeNum(duration, 60000) * 0.2;
  } else {
    brain.lossStreak += 1;
    brain.avgLossDuration =
      brain.avgLossDuration * 0.8 + safeNum(duration, 60000) * 0.2;
  }

  brain.lastTradeDuration = duration;
}

function resetTenant(id) {
  BRAIN_STATE.delete(normalizeTenantKey(id));
  return { ok: true };
}

module.exports = {
  makeDecision,
  resetTenant,
  recordTradeOutcome,
};
