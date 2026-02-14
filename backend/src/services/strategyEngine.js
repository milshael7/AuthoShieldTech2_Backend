// backend/src/services/strategyEngine.js
// Phase 5 — Persistent Adaptive Strategy Engine
// Multi-Tenant Safe + Disk-Persisted Learning + Stable Feedback

const fs = require("fs");
const path = require("path");

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
   LEARNING PERSISTENCE CONFIG
========================================================= */

const LEARNING_VERSION = 1;

const LEARNING_DIR =
  process.env.STRATEGY_LEARNING_DIR ||
  path.join("/tmp", "strategy_learning");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function learningPath(tenantId) {
  ensureDir(LEARNING_DIR);
  const key = tenantId || "__default__";
  return path.join(LEARNING_DIR, `learning_${key}.json`);
}

/* =========================================================
   DEFAULT LEARNING STATE
========================================================= */

function defaultLearning() {
  return {
    version: LEARNING_VERSION,
    edgeMultiplier: 1,
    confidenceMultiplier: 1,
    lastWinRate: 0.5,
    lastEvaluatedTradeCount: 0,
    lastUpdated: Date.now(),
  };
}

const LEARNING_CACHE = new Map();

/* =========================================================
   LOAD / SAVE LEARNING
========================================================= */

function loadLearning(tenantId) {
  const key = tenantId || "__default__";

  if (LEARNING_CACHE.has(key)) {
    return LEARNING_CACHE.get(key);
  }

  const file = learningPath(key);
  let state = defaultLearning();

  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      state = { ...state, ...raw };

      // version migration safeguard
      if (state.version !== LEARNING_VERSION) {
        state = defaultLearning();
      }
    }
  } catch {
    state = defaultLearning();
  }

  LEARNING_CACHE.set(key, state);
  return state;
}

function saveLearning(tenantId) {
  const key = tenantId || "__default__";
  const state = LEARNING_CACHE.get(key);
  if (!state) return;

  try {
    fs.writeFileSync(
      learningPath(key),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

/* =========================================================
   EDGE MODEL
========================================================= */

function computeEdge({ price, lastPrice, volatility }) {
  if (!Number.isFinite(price) || !Number.isFinite(lastPrice)) {
    return 0;
  }

  const vol = volatility || 0.002;
  const momentum = (price - lastPrice) / lastPrice;
  const normalized = momentum / (vol || 0.001);

  return clamp(normalized, -0.02, 0.02);
}

/* =========================================================
   CONFIDENCE MODEL
========================================================= */

function computeConfidence({ edge, ticksSeen }) {
  if (ticksSeen < 50) return 0.4;

  const base = Math.abs(edge) * 8;
  return clamp(base, 0, 1);
}

/* =========================================================
   STABLE PERFORMANCE ADAPTATION
========================================================= */

function adaptFromPerformance(tenantId, paperState) {
  if (!tenantId || !paperState?.trades) return;

  const learning = loadLearning(tenantId);
  const trades = paperState.trades;

  if (trades.length === learning.lastEvaluatedTradeCount) return;
  if (trades.length < 10) return;

  const recent = trades.slice(-20);
  const wins = recent.filter(t => t.profit > 0).length;
  const losses = recent.filter(t => t.profit <= 0).length;

  const total = wins + losses;
  if (!total) return;

  const winRate = wins / total;
  learning.lastWinRate = winRate;

  /* ---- tighten if degrading ---- */
  if (winRate < 0.45) {
    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier * 1.08, 1, 2);

    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier * 1.05, 1, 1.5);
  }

  /* ---- relax if strong ---- */
  if (winRate > 0.65) {
    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier * 0.96, 0.7, 1.5);

    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier * 0.97, 0.7, 1.3);
  }

  learning.lastEvaluatedTradeCount = trades.length;
  learning.lastUpdated = Date.now();

  saveLearning(tenantId);
}

/* =========================================================
   RULE EVALUATION
========================================================= */

function evaluateRules({
  tenantId,
  price,
  edge,
  confidence,
  limits,
  paperState,
}) {
  const learning = loadLearning(tenantId);

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

function adjustRisk({ limits }) {
  const lossesToday = Number(limits?.lossesToday || 0);

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
    tenantId,
    price,
    edge,
    confidence,
    limits,
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
    learning: loadLearning(tenantId),
    ts: Date.now(),
  };
}

module.exports = {
  buildDecision,
};
