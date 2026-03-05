// backend/src/services/evolutionEngine.js
// ==========================================================
// AI Strategy Evolution Engine
// Generates and tests strategy variations automatically
// ==========================================================

const trainingLab = require("./trainingLab");

const MAX_STRATEGIES = 20;

/* ======================================================
STRATEGY GENERATION
====================================================== */

function randomStrategy() {

  return {
    minConfidence: 0.4 + Math.random() * 0.4,
    minEdge: 0.0003 + Math.random() * 0.0015,
    riskMultiplier: 0.5 + Math.random() * 1.5
  };

}

/* ======================================================
TEST STRATEGY
====================================================== */

async function testStrategy(strategy) {

  const result = await trainingLab.trainAI({
    runs: 5
  });

  return {
    strategy,
    score: result.avgEquity
  };

}

/* ======================================================
EVOLUTION LOOP
====================================================== */

async function evolveStrategies() {

  const population = [];

  for (let i = 0; i < MAX_STRATEGIES; i++) {

    const strat = randomStrategy();

    const tested = await testStrategy(strat);

    population.push(tested);

  }

  population.sort((a,b)=>b.score-a.score);

  const winners = population.slice(0,5);

  return {
    bestStrategies: winners
  };

}

module.exports = {
  evolveStrategies
};
