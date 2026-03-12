// ==========================================================
// STRATEGY DIGEST — BODY ↔ OUTSIDE BRAIN BRIDGE
// This layer protects the architecture so the BODY never
// directly controls the strategy brain.
// ==========================================================

const { buildDecision } = require("./strategyEngine");
const learningStore = require("../brain/learningStore");

function runStrategy(context = {}){

  const {
    tenantId,
    symbol,
    price,
    lastPrice,
    volatility,
    ticksSeen
  } = context;

  try{

    // load persistent learning from the outside brain
    const learning =
      learningStore.getLearning(tenantId);

    const decision =
      buildDecision({
        tenantId,
        symbol,
        price,
        lastPrice,
        volatility,
        ticksSeen,
        learning
      });

    return decision || {
      action:"WAIT",
      confidence:0,
      edge:0
    };

  }
  catch(err){

    console.error(
      "[STRATEGY DIGEST ERROR]",
      err.message
    );

    return {
      action:"WAIT",
      confidence:0,
      edge:0
    };

  }

}

module.exports = {
  runStrategy
};
