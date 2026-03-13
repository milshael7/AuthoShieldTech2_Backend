// ==========================================================
// AUTOSHIELD OUTSIDE BRAIN — PERSISTENT AI CORE v19
// Fast Restore • Reinforcement Learning • Safe Writes
// ==========================================================

const { readDb, writeDb } = require("../src/lib/db");

/* =========================================================
CONFIG
========================================================= */

const SIGNAL_MEMORY_LIMIT = 200;
const OUTCOME_MEMORY_LIMIT = 400;
const SAVE_INTERVAL = 4000;

/* =========================================================
ENGINE TELEMETRY
========================================================= */

const ENGINE_BOOT_TIME = Date.now();

let DECISION_COUNTER = 0;
let LAST_DECISION_TS = Date.now();

/* =========================================================
WRITE LOCK
========================================================= */

let WRITE_LOCK = false;

function safeWrite(db){

  if(WRITE_LOCK) return;

  WRITE_LOCK = true;

  try{
    writeDb(db);
  }finally{
    WRITE_LOCK = false;
  }

}

/* =========================================================
UTIL
========================================================= */

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

/* =========================================================
BRAIN STORAGE
========================================================= */

function defaultBrain(){

  return{

    version:19,

    createdAt:Date.now(),
    updatedAt:Date.now(),

    signalMemory:[],
    tradeOutcomes:[],

    stats:{
      totalTrades:0,
      wins:0,
      losses:0,
      winRate:0,
      expectancy:0,
      avgWin:0,
      avgLoss:0
    },

    adaptive:{
      biasBoost:1,
      confidenceBoost:1,
      edgeAmplifier:1,
      degradation:0
    }

  };

}

function getBrain(tenantId){

  const key = tenantId || "__default__";

  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.ai) db.brain.ai = {};

  if(!db.brain.ai[key]){
    db.brain.ai[key] = defaultBrain();
    safeWrite(db);
  }

  return db.brain.ai[key];

}

function saveBrain(tenantId,brain){

  const key = tenantId || "__default__";

  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.ai) db.brain.ai = {};

  brain.updatedAt = Date.now();

  db.brain.ai[key] = brain;

  safeWrite(db);

}

/* =========================================================
REINFORCEMENT LEARNING
========================================================= */

function recordTradeOutcome({tenantId,pnl}){

  const brain = getBrain(tenantId);

  const isWin = pnl > 0;

  brain.tradeOutcomes.push({
    ts:Date.now(),
    pnl,
    isWin
  });

  brain.tradeOutcomes =
    brain.tradeOutcomes.slice(-OUTCOME_MEMORY_LIMIT);

  const wins = brain.tradeOutcomes.filter(t=>t.isWin);
  const losses = brain.tradeOutcomes.filter(t=>!t.isWin);

  brain.stats.totalTrades = brain.tradeOutcomes.length;
  brain.stats.wins = wins.length;
  brain.stats.losses = losses.length;

  brain.stats.winRate =
    brain.stats.totalTrades
      ? wins.length/brain.stats.totalTrades
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
    (1-brain.stats.winRate) * brain.stats.avgLoss;

  adaptBehavior(brain);

  DIRTY.add(tenantId);

}

/* =========================================================
ADAPTIVE LEARNING
========================================================= */

function adaptBehavior(brain){

  const { winRate, expectancy } = brain.stats;

  if(brain.stats.totalTrades < 8) return;

  if(expectancy > 0){

    brain.adaptive.biasBoost =
      clamp(1 + winRate*0.6,1,1.8);

    brain.adaptive.edgeAmplifier =
      clamp(1 + winRate*0.5,1,1.6);

    brain.adaptive.confidenceBoost =
      clamp(1 + winRate*0.4,1,1.5);

    brain.adaptive.degradation = 0;

  }else{

    brain.adaptive.biasBoost =
      clamp(0.9 - Math.abs(expectancy)*0.02,0.5,1);

    brain.adaptive.edgeAmplifier =
      clamp(0.9 - Math.abs(expectancy)*0.02,0.5,1);

    brain.adaptive.confidenceBoost =
      clamp(0.85 - Math.abs(expectancy)*0.02,0.5,1);

    brain.adaptive.degradation++;

  }

}

/* =========================================================
SIGNAL MEMORY
========================================================= */

function recordSignal({tenantId,action,confidence,edge}){

  const brain = getBrain(tenantId);

  brain.signalMemory.push({
    ts:Date.now(),
    action,
    confidence,
    edge
  });

  brain.signalMemory =
    brain.signalMemory.slice(-SIGNAL_MEMORY_LIMIT);

  DIRTY.add(tenantId);

}

/* =========================================================
DECISION OVERLAY
========================================================= */

function decide(context={}){

  DECISION_COUNTER++;
  LAST_DECISION_TS = Date.now();

  const { tenantId, last, paper={} } = context;

  const brain = getBrain(tenantId);

  if(!Number.isFinite(last)){

    return{
      action:"WAIT",
      confidence:0,
      edge:0
    };

  }

  const baseConfidence =
    safeNum(paper?.learnStats?.confidence,0.25);

  const baseEdge =
    safeNum(paper?.learnStats?.trendEdge,0);

  let edge =
    baseEdge * brain.adaptive.edgeAmplifier;

  let confidence =
    baseConfidence * brain.adaptive.confidenceBoost;

  confidence = clamp(confidence,0,1);

  if(confidence > 0.55 && Math.abs(edge) > 0.0005){

    const action =
      edge > 0 ? "BUY" : "SELL";

    recordSignal({
      tenantId,
      action,
      confidence,
      edge
    });

    return{
      action,
      confidence,
      edge
    };

  }

  return{
    action:"WAIT",
    confidence,
    edge
  };

}

/* =========================================================
FAST RESTORE FOR INSIDE BRAIN
========================================================= */

function restoreBrain(tenantId){

  const brain = getBrain(tenantId);

  return{

    expectancy:brain.stats.expectancy,
    winRate:brain.stats.winRate,

    adaptive:brain.adaptive,

    recentSignals:
      brain.signalMemory.slice(-30),

    recentTrades:
      brain.tradeOutcomes.slice(-80)

  };

}

/* =========================================================
TELEMETRY
========================================================= */

function getSnapshot(tenantId){

  const brain = getBrain(tenantId);

  const uptime =
    Math.floor((Date.now()-ENGINE_BOOT_TIME)/1000);

  const decisionsPerMinute =
    DECISION_COUNTER
      ? (DECISION_COUNTER/(uptime/60||1))
      : 0;

  return{

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
DIRTY SAVE LOOP
========================================================= */

const DIRTY = new Set();

setInterval(()=>{

  for(const tenantId of DIRTY){

    const brain = getBrain(tenantId);
    saveBrain(tenantId,brain);

  }

  DIRTY.clear();

},SAVE_INTERVAL);

/* ========================================================= */

module.exports={
  decide,
  recordSignal,
  recordTradeOutcome,
  restoreBrain,
  getSnapshot
};
