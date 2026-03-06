// backend/src/services/aiBrain.js
// ==========================================================
// Adaptive Reinforcement AI Core (Tenant Safe)
// Multi-Signal Fusion + Persistent Learning Engine
// ==========================================================

const fs = require("fs");

/* =========================================================
CONFIG
========================================================= */

const BRAIN_PATH =
  process.env.AI_BRAIN_PATH?.trim() || "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 120);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 80);
const SIGNAL_MEMORY_LIMIT = 100;
const OUTCOME_MEMORY_LIMIT = 200;

/* Fusion Weights */

const TREND_WEIGHT =
  Number(process.env.AI_WEIGHT_TREND || 0.45);

const VOL_WEIGHT =
  Number(process.env.AI_WEIGHT_VOL || 0.25);

const PERFORMANCE_WEIGHT =
  Number(process.env.AI_WEIGHT_PERF || 0.30);

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowIso() {
  return new Date().toISOString();
}

/* =========================================================
TENANT BRAINS
========================================================= */

const BRAINS = new Map();

function defaultBrain() {
  return {
    version: 15,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    history: [],
    notes: [],

    signalMemory: [],
    tradeOutcomes: [],

    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      expectancy: 0,
      avgWin: 0,
      avgLoss: 0,
    },

    adaptive: {
      biasBoost: 1,
      confidenceBoost: 1,
      edgeAmplifier: 1,
      degradation: 0,
    },
  };
}

function getBrain(tenantId) {

  const key = tenantId || "__default__";

  if (!BRAINS.has(key)) {
    BRAINS.set(key, defaultBrain());
  }

  return BRAINS.get(key);

}

/* =========================================================
LOAD / SAVE
========================================================= */

function loadBrain() {

  try {

    if (!fs.existsSync(BRAIN_PATH)) return;

    const raw = JSON.parse(
      fs.readFileSync(BRAIN_PATH, "utf-8")
    );

    for (const tenantId of Object.keys(raw)) {

      BRAINS.set(tenantId, {
        ...defaultBrain(),
        ...raw[tenantId],
      });

    }

  } catch (err) {

    console.error("AI brain load error:", err);

  }

}

function saveBrain() {

  try {

    const obj = {};

    for (const [tenantId, brain] of BRAINS.entries()) {

      brain.updatedAt = nowIso();
      obj[tenantId] = brain;

    }

    const temp = `${BRAIN_PATH}.tmp`;

    fs.writeFileSync(
      temp,
      JSON.stringify(obj, null, 2)
    );

    fs.renameSync(temp, BRAIN_PATH);

  } catch (err) {

    console.error("AI brain save error:", err);

  }

}

loadBrain();

/* =========================================================
REINFORCEMENT LEARNING
========================================================= */

function recordTradeOutcome({ tenantId, pnl }) {

  const brain = getBrain(tenantId);

  const isWin = pnl > 0;

  brain.tradeOutcomes.push({
    ts: Date.now(),
    pnl,
    isWin,
  });

  brain.tradeOutcomes =
    brain.tradeOutcomes.slice(-OUTCOME_MEMORY_LIMIT);

  const wins = brain.tradeOutcomes.filter(t => t.isWin);
  const losses = brain.tradeOutcomes.filter(t => !t.isWin);

  brain.stats.totalTrades = brain.tradeOutcomes.length;
  brain.stats.wins = wins.length;
  brain.stats.losses = losses.length;

  brain.stats.winRate =
    brain.stats.totalTrades
      ? wins.length / brain.stats.totalTrades
      : 0;

  brain.stats.avgWin =
    wins.length
      ? wins.reduce((a,b)=>a+b.pnl,0)/wins.length
      : 0;

  brain.stats.avgLoss =
    losses.length
      ? losses.reduce((a,b)=>a+Math.abs(b.pnl),0)/losses.length
      : 0;

  brain.stats.expectancy =
    brain.stats.winRate * brain.stats.avgWin -
    (1 - brain.stats.winRate) * brain.stats.avgLoss;

  adaptBehavior(brain);

  saveBrain();

}

/* =========================================================
ADAPTIVE BEHAVIOR
========================================================= */

function adaptBehavior(brain){

  const { winRate, expectancy } = brain.stats;

  if (brain.stats.totalTrades < 10) return;

  if (expectancy > 0) {

    brain.adaptive.biasBoost =
      clamp(1 + winRate * 0.5, 1, 1.6);

    brain.adaptive.edgeAmplifier =
      clamp(1 + winRate * 0.4, 1, 1.5);

    brain.adaptive.confidenceBoost =
      clamp(1 + winRate * 0.3, 1, 1.4);

    brain.adaptive.degradation = 0;

  } else {

    brain.adaptive.biasBoost =
      clamp(0.9 - Math.abs(expectancy)*0.01,0.6,1);

    brain.adaptive.edgeAmplifier =
      clamp(0.9 - Math.abs(expectancy)*0.01,0.6,1);

    brain.adaptive.confidenceBoost =
      clamp(0.85 - Math.abs(expectancy)*0.01,0.6,1);

    brain.adaptive.degradation++;

  }

}

/* =========================================================
SIGNAL MEMORY
========================================================= */

function recordSignal({ tenantId, action, confidence, edge }) {

  const brain = getBrain(tenantId);

  brain.signalMemory.push({
    ts: Date.now(),
    action,
    confidence,
    edge
  });

  brain.signalMemory =
    brain.signalMemory.slice(-SIGNAL_MEMORY_LIMIT);

  saveBrain();

}

/* =========================================================
MULTI SIGNAL FUSION
========================================================= */

function fuseSignals({ trendEdge, volatility, expectancy }) {

  const trendScore =
    clamp(trendEdge * TREND_WEIGHT, -1, 1);

  const volScore =
    clamp((0.02 - volatility) * VOL_WEIGHT, -1, 1);

  const perfScore =
    clamp(expectancy * PERFORMANCE_WEIGHT, -1, 1);

  return trendScore + volScore + perfScore;

}

/* =========================================================
DECISION OVERLAY
========================================================= */

function decide(context = {}) {

  const {
    tenantId,
    last,
    paper = {}
  } = context;

  const brain = getBrain(tenantId);

  const learn = paper.learnStats || {};

  const baseEdge = safeNum(learn.trendEdge, 0);
  const baseConfidence = safeNum(learn.confidence, 0);
  const volatility = safeNum(paper.volatility, 0);

  if (!Number.isFinite(last)) {

    return {
      action:"WAIT",
      confidence:0,
      edge:0
    };

  }

  /* SIGNAL FUSION */

  const fusedEdge =
    fuseSignals({
      trendEdge: baseEdge,
      volatility,
      expectancy: brain.stats.expectancy
    });

  let edge =
    fusedEdge * brain.adaptive.edgeAmplifier;

  let confidence =
    baseConfidence * brain.adaptive.confidenceBoost;

  confidence = clamp(confidence,0,1);

  /* DECISION */

  if (confidence > 0.7 && Math.abs(edge) > 0.001) {

    const action =
      edge > 0 ? "BUY" : "SELL";

    recordSignal({
      tenantId,
      action,
      confidence,
      edge
    });

    return {
      action,
      confidence,
      edge
    };

  }

  return {
    action:"WAIT",
    confidence,
    edge
  };

}

/* =========================================================
SNAPSHOT
========================================================= */

function getSnapshot(tenantId) {

  const brain = getBrain(tenantId);

  return {
    ok:true,
    stats:brain.stats,
    adaptive:brain.adaptive,
    signalMemory:brain.signalMemory.length,
    tradeMemory:brain.tradeOutcomes.length
  };

}

/* =========================================================
RESET
========================================================= */

function resetBrain(tenantId) {

  const key = tenantId || "__default__";

  BRAINS.set(key, defaultBrain());

  saveBrain();

}

/* ========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  recordSignal,
  getSnapshot,
  resetBrain
};
