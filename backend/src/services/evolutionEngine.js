// ==========================================================
// FILE: backend/src/services/evolutionEngine.js
// MODULE: AI Strategy Evolution Engine
//
// PURPOSE
// Generates and evaluates AI strategy variations safely.
//
// SAFETY IMPROVEMENTS
// ----------------------------------------------------------
// 1. Limits number of strategies to prevent CPU overload
// 2. Prevents evolution during live trading
// 3. Adds error protection
// 4. Prevents runaway training loops
// ==========================================================

const trainingLab = require("./trainingLab");

/* ======================================================
CONFIG
====================================================== */

const MAX_STRATEGIES =
  Math.min(
    Number(process.env.MAX_STRATEGIES || 10),
    20
  );

const TRAINING_RUNS =
  Math.min(
    Number(process.env.EVOLUTION_RUNS || 3),
    10
  );

/* ======================================================
SAFETY CHECK
====================================================== */

function ensureEvolutionAllowed(){

  const mode = process.env.TRADING_MODE || "paper";

  if(mode === "live"){

    throw new Error(
      "Evolution engine disabled during LIVE trading"
    );

  }

}

/* ======================================================
STRATEGY GENERATION
====================================================== */

function randomStrategy(){

  return {

    minConfidence:
      0.4 + Math.random() * 0.4,

    minEdge:
      0.0003 + Math.random() * 0.0015,

    riskMultiplier:
      0.5 + Math.random() * 1.5

  };

}

/* ======================================================
TEST STRATEGY
====================================================== */

async function testStrategy(strategy){

  try{

    const result =
      await trainingLab.trainAI({

        runs: TRAINING_RUNS

      });

    return {

      strategy,
      score: Number(result.avgEquity || 0)

    };

  }
  catch(err){

    console.error(
      "Strategy test failed:",
      err.message
    );

    return {

      strategy,
      score: 0

    };

  }

}

/* ======================================================
EVOLUTION LOOP
====================================================== */

async function evolveStrategies(){

  ensureEvolutionAllowed();

  const population = [];

  for(let i=0;i<MAX_STRATEGIES;i++){

    try{

      const strat = randomStrategy();

      const tested =
        await testStrategy(strat);

      population.push(tested);

    }
    catch(err){

      console.error(
        "Evolution iteration failed:",
        err.message
      );

    }

  }

  if(population.length === 0){

    return {

      bestStrategies: []

    };

  }

  population.sort(
    (a,b)=>b.score-a.score
  );

  const winners =
    population.slice(0,5);

  return {

    bestStrategies: winners

  };

}

/* ======================================================
EXPORT
====================================================== */

module.exports = {

  evolveStrategies

};
