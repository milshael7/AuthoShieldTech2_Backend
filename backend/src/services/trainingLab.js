// ==========================================================
// FILE: backend/src/services/trainingLab.js
// MODULE: AI Training Lab
//
// PURPOSE
// Offline Simulation + Strategy Evolution testing
//
// IMPORTANT SAFETY NOTES
// ----------------------------------------------------------
// 1. Training MUST NOT run during live trading.
// 2. Training runs in isolated tenant namespaces.
// 3. Simulation rounds limited to prevent CPU overload.
// 4. Prevents accidental reset of real trading engine.
// ==========================================================

const paperTrader = require("./paperTrader");
const aiBrain = require("./aiBrain");

/* ======================================================
CONFIGURATION
====================================================== */

const SIMULATION_ROUNDS =
  Math.min(
    Number(process.env.TRAINING_SIM_ROUNDS || 500),
    1000
  ); // hard safety cap

const PRICE_START = 65000;

/* ======================================================
SAFETY CHECK
====================================================== */

function ensureTrainingAllowed(){

  const mode = process.env.TRADING_MODE || "paper";

  if(mode === "live"){
    throw new Error(
      "TrainingLab disabled during LIVE trading"
    );
  }

}

/* ======================================================
PRICE MOVEMENT SIMULATION
====================================================== */

function randomMove(price){

  const drift = (Math.random() - 0.5) * 0.002;

  const next = price * (1 + drift);

  if(!Number.isFinite(next) || next <= 0){
    return price;
  }

  return next;

}

/* ======================================================
SINGLE SIMULATION
====================================================== */

async function runSimulation({

  tenantId = "lab",
  symbol = "BTCUSDT"

} = {}){

  ensureTrainingAllowed();

  let price = PRICE_START;

  // isolate tenant to prevent touching real trader
  const simulationTenant = `training_${tenantId}_${Date.now()}`;

  try{

    paperTrader.hardReset(simulationTenant);

    for(let i=0;i<SIMULATION_ROUNDS;i++){

      price = randomMove(price);

      paperTrader.tick(
        simulationTenant,
        symbol,
        price,
        Date.now()
      );

    }

    const result =
      paperTrader.snapshot(simulationTenant);

    return {

      equity: Number(result.equity || 0),
      trades: Array.isArray(result.trades)
        ? result.trades.length
        : 0

    };

  }
  catch(err){

    console.error(
      "Training simulation failed:",
      err.message
    );

    return {
      equity: 0,
      trades: 0
    };

  }

}

/* ======================================================
MULTI RUN TRAINING
====================================================== */

async function trainAI({

  runs = 10,
  tenantId = "lab",
  symbol = "BTCUSDT"

} = {}){

  ensureTrainingAllowed();

  const safeRuns =
    Math.min(runs, 20); // prevent runaway CPU

  const results = [];

  for(let i=0;i<safeRuns;i++){

    try{

      const res =
        await runSimulation({
          tenantId: `${tenantId}_${i}`,
          symbol
        });

      results.push(res);

    }
    catch(err){

      console.error(
        "Training run failed:",
        err.message
      );

    }

  }

  if(results.length === 0){

    return {
      runs: 0,
      avgEquity: 0,
      avgTrades: 0,
      results: []
    };

  }

  const avgEquity =
    results.reduce((a,b)=>a+b.equity,0)
    / results.length;

  const avgTrades =
    results.reduce((a,b)=>a+b.trades,0)
    / results.length;

  return {

    runs: results.length,
    avgEquity,
    avgTrades,
    results

  };

}

/* ======================================================
EXPORTS
====================================================== */

module.exports = {

  runSimulation,
  trainAI

};
