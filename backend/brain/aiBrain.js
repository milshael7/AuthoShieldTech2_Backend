// ==========================================================
// 🔒 AUTOSHIELD OUTSIDE BRAIN — FINAL UNIFIED CORE v20
// Persistent • Cached • Stable • Reinforcement Learning
// ==========================================================

const { readDb, writeDb } = require("../src/lib/db");

/* =========================================================
CONFIG
========================================================= */

const SIGNAL_MEMORY_LIMIT = 200;
const OUTCOME_MEMORY_LIMIT = 400;
const SAVE_INTERVAL = 4000;

/* =========================================================
CACHE (🔥 CRITICAL FIX)
========================================================= */

const BRAIN_CACHE = new Map();

/* =========================================================
UTIL
========================================================= */

function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* =========================================================
DEFAULT
========================================================= */

function defaultBrain() {
  return {
    version: 20,
    createdAt: Date.now(),
    updatedAt: Date.now(),

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

/* =========================================================
LOAD (WITH CACHE)
========================================================= */

function getBrain(tenantId) {
  const key = tenantId || "__default__";

  if (BRAIN_CACHE.has(key)) {
    return BRAIN_CACHE.get(key);
  }

  const db = readDb();

  if (!db.brain) db.brain = {};
  if (!db.brain.ai) db.brain.ai = {};

  let brain = db.brain.ai[key];

  if (!brain) {
    brain = defaultBrain();
    db.brain.ai[key] = brain;
    writeDb(db);
  }

  BRAIN_CACHE.set(key, brain);

  return brain;
}

/* =========================================================
SAVE
========================================================= */

function saveBrain(tenantId) {
  const key = tenantId || "__default__";

  const brain = BRAIN_CACHE.get(key);
  if (!brain) return;

  const db = readDb();

  if (!db.brain) db.brain = {};
  if (!db.brain.ai) db.brain.ai = {};

  brain.updatedAt = Date.now();
  db.brain.ai[key] = brain;

  writeDb(db);
}

/* =========================================================
LEARNING
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
      ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length
      : 0;

  brain.stats.avgLoss =
    losses.length
      ? losses.reduce((a, b) => a + Math.abs(b.pnl), 0) / losses.length
      : 0;

  brain.stats.expectancy =
    brain.stats.winRate * brain.stats.avgWin -
    (1 - brain.stats.winRate) * brain.stats.avgLoss;

  adapt(brain);
  DIRTY.add(tenantId);
}

/* =========================================================
ADAPT
========================================================= */

function adapt(brain) {
  const { winRate, expectancy } = brain.stats;

  if (brain.stats.totalTrades < 8) return;

  if (expectancy > 0) {
    brain.adaptive.biasBoost = clamp(1 + winRate * 0.6, 1, 1.8);
    brain.adaptive.edgeAmplifier = clamp(1 + winRate * 0.5, 1, 1.6);
    brain.adaptive.confidenceBoost = clamp(1 + winRate * 0.4, 1, 1.5);
    brain.adaptive.degradation = 0;
  } else {
    brain.adaptive.biasBoost = clamp(0.9, 0.5, 1);
    brain.adaptive.edgeAmplifier = clamp(0.9, 0.5, 1);
    brain.adaptive.confidenceBoost = clamp(0.85, 0.5, 1);
    brain.adaptive.degradation++;
  }
}

/* =========================================================
SIGNALS
========================================================= */

function recordSignal({ tenantId, action, confidence, edge }) {
  const brain = getBrain(tenantId);

  brain.signalMemory.push({
    ts: Date.now(),
    action,
    confidence,
    edge,
  });

  brain.signalMemory =
    brain.signalMemory.slice(-SIGNAL_MEMORY_LIMIT);

  DIRTY.add(tenantId);
}

/* =========================================================
DECISION ENGINE (🔥 IMPROVED)
========================================================= */

function decide({ tenantId, last, paper = {} } = {}) {
  const brain = getBrain(tenantId);

  if (!Number.isFinite(last)) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  // fallback intelligence
  const baseConfidence =
    safeNum(paper?.learnStats?.confidence, 0.35);

  const baseEdge =
    safeNum(paper?.learnStats?.trendEdge, 0.0003);

  let edge = baseEdge * brain.adaptive.edgeAmplifier;
  let confidence =
    baseConfidence * brain.adaptive.confidenceBoost;

  confidence = clamp(confidence, 0, 1);

  if (confidence > 0.55 && Math.abs(edge) > 0.0004) {
    const action = edge > 0 ? "BUY" : "SELL";

    recordSignal({
      tenantId,
      action,
      confidence,
      edge,
    });

    return { action, confidence, edge };
  }

  return { action: "WAIT", confidence, edge };
}

/* =========================================================
RESTORE
========================================================= */

function restoreBrain(tenantId) {
  const brain = getBrain(tenantId);

  return {
    expectancy: brain.stats.expectancy,
    winRate: brain.stats.winRate,
    adaptive: brain.adaptive,
    recentSignals: brain.signalMemory.slice(-30),
    recentTrades: brain.tradeOutcomes.slice(-80),
  };
}

/* =========================================================
SNAPSHOT
========================================================= */

function getSnapshot(tenantId) {
  const brain = getBrain(tenantId);

  return {
    stats: brain.stats,
    adaptive: brain.adaptive,
    signals: brain.signalMemory.length,
    trades: brain.tradeOutcomes.length,
  };
}

/* =========================================================
SAVE LOOP
========================================================= */

const DIRTY = new Set();

setInterval(() => {
  for (const tenantId of DIRTY) {
    saveBrain(tenantId);
  }
  DIRTY.clear();
}, SAVE_INTERVAL);

/* ========================================================= */

module.exports = {
  decide,
  recordSignal,
  recordTradeOutcome,
  restoreBrain,
  getSnapshot,
};
