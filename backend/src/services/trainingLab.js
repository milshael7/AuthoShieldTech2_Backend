// backend/src/services/trainingLab.js
// ==========================================================
// AI Training Lab
// Offline Simulation + Strategy Evolution
// ==========================================================

const paperTrader = require("./paperTrader");
const aiBrain = require("./aiBrain");

const SIMULATION_ROUNDS =
  Number(process.env.TRAINING_SIM_ROUNDS || 2000);

const PRICE_START = 65000;

function randomMove(price){
  const drift = (Math.random()-0.5) * 0.002;
  return price * (1 + drift);
}

/* ======================================================
SIMULATION
====================================================== */

async function runSimulation({
  tenantId="lab",
  symbol="BTCUSDT"
}={}){

  let price = PRICE_START;

  paperTrader.hardReset(tenantId);

  for(let i=0;i<SIMULATION_ROUNDS;i++){

    price = randomMove(price);

    paperTrader.tick(
      tenantId,
      symbol,
      price,
      Date.now()
    );

  }

  const result =
    paperTrader.snapshot(tenantId);

  return {
    equity: result.equity,
    trades: result.trades.length
  };

}

/* ======================================================
MULTI RUN TRAINING
====================================================== */

async function trainAI({

  runs=20,
  tenantId="lab",
  symbol="BTCUSDT"

}={}){

  const results = [];

  for(let i=0;i<runs;i++){

    const res =
      await runSimulation({
        tenantId:`lab_${i}`,
        symbol
      });

    results.push(res);

  }

  const avgEquity =
    results.reduce((a,b)=>a+b.equity,0)/runs;

  const avgTrades =
    results.reduce((a,b)=>a+b.trades,0)/runs;

  return {
    runs,
    avgEquity,
    avgTrades,
    results
  };

}

module.exports={
  runSimulation,
  trainAI
};
