// backend/src/services/strategyEngine.js
// Phase 10 — Institutional Regime-Aware Strategy Core (Corrected)
// Persistent Learning + Regime Detection + Adaptive Weighting
// Tenant Safe • Deterministic • Disk Persisted

const fs = require("fs");
const path = require("path");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   BASE CONFIG
========================================================= */

const BASE_CONFIG = Object.freeze({
  minConfidence: Number(process.env.TRADE_MIN_CONF || 0.62),
  minEdge: Number(process.env.TRADE_MIN_EDGE || 0.0007),

  baseRiskPct: Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct: Number(process.env.TRADE_MAX_RISK || 0.02),

  maxDailyTrades: Number(process.env.TRADE_MAX_TRADES_PER_DAY || 15),

  regimeTrendEdgeBoost: 1.25,
  regimeRangeEdgeCut: 0.75,
});

/* =========================================================
   LEARNING CONFIG
========================================================= */

const LEARNING_VERSION = 3;

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
   LOAD / SAVE
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
   REGIME DETECTION
========================================================= */

function detectRegime({ price, lastPrice, volatility }) {
  if (!lastPrice) return "neutral";

  const move = Math.abs((price - lastPrice) / lastPrice);

  if (volatility > 0.02 && move > 0.01) return "expansion";
  if (move > volatility * 1.5) return "trend";
  if (move < volatility * 0.5) return "range";

  return "neutral";
}

/* =========================================================
   EDGE MODEL
========================================================= */

function computeEdge({ price, lastPrice, volatility, regime }) {
  if (!Number.isFinite(price) || !Number.isFinite(lastPrice)) {
    return 0;
  }

  const vol = volatility || 0.002;
  const momentum = (price - lastPrice) / lastPrice;

  let normalized = momentum / (vol || 0.001);

  if (regime === "trend") {
    normalized *= BASE_CONFIG.regimeTrendEdgeBoost;
  }

  if (regime === "range") {
    normalized *= BASE_CONFIG.regimeRangeEdgeCut;
  }

  return clamp(normalized, -0.03, 0.03);
}

/* =========================================================
   CONFIDENCE MODEL
========================================================= */

function computeConfidence({ edge, ticksSeen, regime }) {
  if (ticksSeen < 50) return 0.4;

  let base = Math.abs(edge) * 6;

  if (regime === "expansion") base *= 1.1;
  if (regime === "range") base *= 0.85;

  return clamp(base, 0, 1);
}

/* =========================================================
   PERFORMANCE ADAPTATION
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

  if (winRate < 0.45) {
    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier * 1.06, 1, 2);
    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier * 1.04, 1, 1.5);
  }

  if (winRate > 0.65) {
    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier * 0.97, 0.7, 1.5);
    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier * 0.97, 0.7, 1.3);
  }

  learning.lastEvaluatedTradeCount = trades.length;
  learning.lastUpdated = Date.now();

  saveLearning(tenantId);
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

  const learning = loadLearning(tenantId);
  adaptFromPerformance(tenantId, paperState);

  const regime = detectRegime({
    price,
    lastPrice,
    volatility,
  });

  let edge = computeEdge({
    price,
    lastPrice,
    volatility,
    regime,
  });

  let confidence = computeConfidence({
    edge,
    ticksSeen,
    regime,
  });

  /* 🔥 APPLY LEARNING MULTIPLIERS */

  edge *= learning.edgeMultiplier;
  confidence *= learning.confidenceMultiplier;

  edge = clamp(edge, -0.05, 0.05);
  confidence = clamp(confidence, 0, 1);

  if (!Number.isFinite(price)) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  if (confidence < BASE_CONFIG.minConfidence) {
    return { action: "WAIT", confidence, edge };
  }

  if (Math.abs(edge) < BASE_CONFIG.minEdge) {
    return { action: "WAIT", confidence, edge };
  }

  const riskPct = clamp(
    BASE_CONFIG.baseRiskPct,
    BASE_CONFIG.baseRiskPct,
    BASE_CONFIG.maxRiskPct
  );

  return {
    symbol,
    action: edge > 0 ? "BUY" : "SELL",
    confidence,
    edge,
    riskPct,
    regime,
    learning,
    ts: Date.now(),
  };
}

module.exports = {
  buildDecision,
};
