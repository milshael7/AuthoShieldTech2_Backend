// backend/src/services/aiBrain.js
// Phase 13 — Reinforcement Adaptive AI Core
// Self-Evolving Bias Engine
// Paper-Learning Integrated
// Tenant Safe • Persistent • Institutional Grade

const fs = require("fs");

/* =========================================================
   CONFIG
========================================================= */

const BRAIN_PATH =
  process.env.AI_BRAIN_PATH?.trim() || "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 120);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 80);
const SIGNAL_MEMORY_LIMIT = 100;

/* =========================================================
   UTILITIES
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
   BRAIN STATE
========================================================= */

function defaultBrain() {
  return {
    version: 13,
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

let brain = defaultBrain();

/* =========================================================
   LOAD / SAVE
========================================================= */

function loadBrain() {
  try {
    if (!fs.existsSync(BRAIN_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(BRAIN_PATH, "utf-8"));
    brain = { ...defaultBrain(), ...raw };
  } catch {}
}

function saveBrain() {
  try {
    brain.updatedAt = nowIso();
    fs.writeFileSync(
      BRAIN_PATH,
      JSON.stringify(brain, null, 2)
    );
  } catch {}
}

loadBrain();

/* =========================================================
   REINFORCEMENT LEARNING
========================================================= */

function recordTradeOutcome({ pnl }) {
  const isWin = pnl > 0;

  brain.tradeOutcomes.push({
    ts: Date.now(),
    pnl,
    isWin,
  });

  brain.tradeOutcomes =
    brain.tradeOutcomes.slice(-200);

  const wins = brain.tradeOutcomes.filter(t => t.isWin);
  const losses = brain.tradeOutcomes.filter(t => !t.isWin);

  brain.stats.totalTrades = brain.tradeOutcomes.length;
  brain.stats.wins = wins.length;
  brain.stats.losses = losses.length;

  brain.stats.winRate =
    brain.stats.totalTrades > 0
      ? wins.length / brain.stats.totalTrades
      : 0;

  brain.stats.avgWin =
    wins.length > 0
      ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length
      : 0;

  brain.stats.avgLoss =
    losses.length > 0
      ? losses.reduce((a, b) => a + Math.abs(b.pnl), 0) / losses.length
      : 0;

  brain.stats.expectancy =
    brain.stats.winRate * brain.stats.avgWin -
    (1 - brain.stats.winRate) * brain.stats.avgLoss;

  adaptBehavior();

  saveBrain();
}

function adaptBehavior() {
  const { winRate, expectancy } = brain.stats;

  /* Positive expectancy scaling */
  if (expectancy > 0) {
    brain.adaptive.biasBoost = clamp(
      1 + winRate * 0.5,
      1,
      1.6
    );

    brain.adaptive.edgeAmplifier = clamp(
      1 + winRate * 0.4,
      1,
      1.5
    );

    brain.adaptive.confidenceBoost = clamp(
      1 + winRate * 0.3,
      1,
      1.4
    );

    brain.adaptive.degradation = 0;
  }

  /* Negative expectancy dampening */
  else {
    brain.adaptive.biasBoost = clamp(
      0.9 - Math.abs(expectancy) * 0.01,
      0.6,
      1
    );

    brain.adaptive.edgeAmplifier = clamp(
      0.9 - Math.abs(expectancy) * 0.01,
      0.6,
      1
    );

    brain.adaptive.confidenceBoost = clamp(
      0.85 - Math.abs(expectancy) * 0.01,
      0.6,
      1
    );

    brain.adaptive.degradation++;
  }
}

/* =========================================================
   SIGNAL MEMORY
========================================================= */

function recordSignal(result) {
  brain.signalMemory.push({
    ts: Date.now(),
    action: result.action,
    confidence: result.confidence,
    edge: result.edge,
  });

  brain.signalMemory =
    brain.signalMemory.slice(-SIGNAL_MEMORY_LIMIT);

  saveBrain();
}

/* =========================================================
   DECISION LAYER
========================================================= */

function decide(context = {}) {
  const last = safeNum(context.last, NaN);
  const paper = context.paper || {};
  const learn = paper.learnStats || {};

  if (!Number.isFinite(last)) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  const baseEdge = safeNum(learn.trendEdge, 0);
  const baseConfidence = safeNum(learn.confidence, 0);

  if (Math.abs(baseEdge) < 0.0005) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  let edge =
    baseEdge * brain.adaptive.edgeAmplifier;

  let confidence =
    baseConfidence * brain.adaptive.confidenceBoost;

  confidence = clamp(confidence, 0, 1);

  if (confidence > 0.7 && Math.abs(edge) > 0.001) {
    const action = edge > 0 ? "BUY" : "SELL";

    const result = {
      action,
      confidence,
      edge,
    };

    recordSignal(result);
    return result;
  }

  return {
    action: "WAIT",
    confidence,
    edge,
  };
}

/* =========================================================
   SNAPSHOT
========================================================= */

function getSnapshot() {
  return {
    ok: true,
    stats: brain.stats,
    adaptive: brain.adaptive,
    signalMemory: brain.signalMemory.length,
    tradeMemory: brain.tradeOutcomes.length,
  };
}

/* ========================================================= */

function resetBrain() {
  brain = defaultBrain();
  saveBrain();
}

module.exports = {
  decide,
  recordTradeOutcome,
  getSnapshot,
  resetBrain,
};
