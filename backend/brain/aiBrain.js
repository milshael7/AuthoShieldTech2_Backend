// ==========================================================
// AUTOSHIELD OUTSIDE BRAIN — PERSISTENT AI CORE
// Standalone learning brain for trading + platform memory
// Lives outside the body and survives body upgrades
// ==========================================================

const { readDb, writeDb } = require("../src/lib/db");

/* =========================================================
CONFIG
========================================================= */

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
ENGINE TELEMETRY
========================================================= */

const ENGINE_BOOT_TIME = Date.now();

let DECISION_COUNTER = 0;
let LAST_DECISION_TS = Date.now();

function recordDecisionTick(){
  DECISION_COUNTER++;
  LAST_DECISION_TS = Date.now();
}

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
BRAIN STORAGE
========================================================= */

function defaultBrain() {
  return {
    version: 17,
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
  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.ai) db.brain.ai = {};

  if(!db.brain.ai[key]){
    db.brain.ai[key] = defaultBrain();
    writeDb(db);
  }

  return db.brain.ai[key];

}

function saveBrain(tenantId, brain) {

  const key = tenantId || "__default__";
  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.ai) db.brain.ai = {};

  brain.updatedAt = nowIso();
  db.brain.ai[key] = brain;

  writeDb(db);

}

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

  saveBrain(tenantId, brain);

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

  saveBrain(tenantId, brain);

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

  recordDecisionTick();

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
SNAPSHOT + TELEMETRY
========================================================= */

function getSnapshot(tenantId) {

  const brain = getBrain(tenantId);

  const uptime =
    Math.floor((Date.now() - ENGINE_BOOT_TIME) / 1000);

  const decisionsPerMinute =
    DECISION_COUNTER
      ? (DECISION_COUNTER / (uptime / 60 || 1))
      : 0;

  return {

    ok:true,

    stats:brain.stats,

    adaptive:brain.adaptive,

    signalMemory:brain.signalMemory.length,
    tradeMemory:brain.tradeOutcomes.length,

    telemetry:{
      uptime,
      decisionsPerMinute:Number(decisionsPerMinute.toFixed(2)),
      lastDecision:LAST_DECISION_TS,
      memoryUsage:process.memoryUsage().rss
    }

  };

}

/* =========================================================
RESET
========================================================= */

function resetBrain(tenantId) {

  const key = tenantId || "__default__";
  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.ai) db.brain.ai = {};

  db.brain.ai[key] = defaultBrain();
  writeDb(db);

}

/* ========================================================= */

module.exports = {
  decide,
  recordTradeOutcome,
  recordSignal,
  getSnapshot,
  resetBrain
};
