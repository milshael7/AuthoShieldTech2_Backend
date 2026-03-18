// ==========================================================
// FILE: backend/src/services/evolutionEngine.js
// MODULE: AI Strategy Evolution Engine
// VERSION: v2 (Safe Strategy Evaluation + Run Lock)
// ==========================================================

const trainingLab = require("./trainingLab");

/* ======================================================
CONFIG
====================================================== */

function clamp(n, min, max){
  return Math.max(min, Math.min(max, n));
}

function safeNum(v, fallback = 0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_STRATEGIES =
  clamp(
    safeNum(process.env.MAX_STRATEGIES, 10),
    1,
    20
  );

const TRAINING_RUNS =
  clamp(
    safeNum(process.env.EVOLUTION_RUNS, 3),
    1,
    10
  );

const TOP_WINNERS =
  clamp(
    safeNum(process.env.EVOLUTION_TOP_WINNERS, 5),
    1,
    10
  );

const EVOLUTION_TIMEOUT_MS =
  clamp(
    safeNum(process.env.EVOLUTION_TIMEOUT_MS, 120000),
    10000,
    900000
  );

/* ======================================================
RUNTIME LOCK
====================================================== */

let EVOLUTION_RUNNING = false;
let LAST_EVOLUTION_AT = 0;

/* ======================================================
SAFETY CHECK
====================================================== */

function ensureEvolutionAllowed(){

  const mode =
    String(process.env.TRADING_MODE || "paper")
      .trim()
      .toLowerCase();

  if(mode === "live"){
    throw new Error(
      "Evolution engine disabled during LIVE trading"
    );
  }
}

/* ======================================================
TIMEOUT WRAPPER
====================================================== */

function withTimeout(promise, ms){

  return Promise.race([
    promise,
    new Promise((_, reject)=>{
      const id = setTimeout(()=>{
        clearTimeout(id);
        reject(
          new Error(
            `Evolution task timed out after ${ms}ms`
          )
        );
      }, ms);
    })
  ]);
}

/* ======================================================
STRATEGY GENERATION
====================================================== */

function randomStrategy(){

  return {
    minConfidence:
      Number((0.4 + Math.random() * 0.4).toFixed(4)),

    minEdge:
      Number((0.0003 + Math.random() * 0.0015).toFixed(6)),

    riskMultiplier:
      Number((0.5 + Math.random() * 1.5).toFixed(4))
  };
}

/* ======================================================
TRAINING RESULT SCORE
====================================================== */

function scoreTrainingResult(result){

  const avgEquity =
    safeNum(result?.avgEquity, 0);

  const endingEquity =
    safeNum(result?.endingEquity, avgEquity);

  const pnl =
    safeNum(result?.pnl, 0);

  const winRate =
    safeNum(result?.winRate, 0);

  const drawdown =
    safeNum(result?.maxDrawdown, 0);

  const trades =
    safeNum(result?.trades, 0);

  let score = 0;

  score += avgEquity;
  score += endingEquity * 0.25;
  score += pnl * 5;
  score += winRate * 100;
  score += trades * 0.5;
  score -= Math.abs(drawdown) * 50;

  return Number(score.toFixed(4));
}

/* ======================================================
TEST STRATEGY
====================================================== */

async function testStrategy(strategy){

  try{

    const result =
      await withTimeout(
        trainingLab.trainAI({
          runs: TRAINING_RUNS,
          strategy
        }),
        EVOLUTION_TIMEOUT_MS
      );

    return {
      strategy,
      result: result || {},
      score: scoreTrainingResult(result),
      ok: true
    };
  }
  catch(err){

    console.error(
      "Strategy test failed:",
      err.message
    );

    return {
      strategy,
      result: null,
      score: 0,
      ok: false,
      error: err.message
    };
  }
}

/* ======================================================
EVOLUTION LOOP
====================================================== */

async function evolveStrategies(){

  ensureEvolutionAllowed();

  if(EVOLUTION_RUNNING){
    return {
      ok: false,
      skipped: true,
      reason: "EVOLUTION_ALREADY_RUNNING",
      bestStrategies: [],
      tested: 0,
      generated: 0,
      startedAt: null,
      finishedAt: Date.now()
    };
  }

  EVOLUTION_RUNNING = true;

  const startedAt = Date.now();

  try{

    const population = [];

    for(let i = 0; i < MAX_STRATEGIES; i++){

      const strategy = randomStrategy();
      const tested = await testStrategy(strategy);
      population.push(tested);

    }

    const successful =
      population.filter(item => item.ok);

    successful.sort((a,b)=>b.score-a.score);

    const winners =
      successful.slice(0, TOP_WINNERS);

    LAST_EVOLUTION_AT = Date.now();

    return {
      ok: true,
      skipped: false,
      generated: population.length,
      tested: successful.length,
      failed: population.length - successful.length,
      startedAt,
      finishedAt: LAST_EVOLUTION_AT,
      durationMs: LAST_EVOLUTION_AT - startedAt,
      bestStrategies: winners
    };

  }
  catch(err){

    console.error(
      "Evolution engine failed:",
      err.message
    );

    return {
      ok: false,
      skipped: false,
      error: err.message,
      bestStrategies: [],
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt
    };
  }
  finally{
    EVOLUTION_RUNNING = false;
  }
}

/* ======================================================
STATUS
====================================================== */

function getEvolutionStatus(){
  return {
    running: EVOLUTION_RUNNING,
    lastEvolutionAt: LAST_EVOLUTION_AT,
    maxStrategies: MAX_STRATEGIES,
    trainingRuns: TRAINING_RUNS,
    timeoutMs: EVOLUTION_TIMEOUT_MS
  };
}

/* ======================================================
EXPORT
====================================================== */

module.exports = {
  evolveStrategies,
  getEvolutionStatus
};
