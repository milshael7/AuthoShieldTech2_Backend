// backend/src/services/counterfactualEngine.js
// Phase 2 Counterfactual Learning Engine
// Learns from signals that were not executed
// Adaptive Edge Reinforcement

const MEMORY = new Map();

const MAX_SIGNALS = 200;
const LOOKAHEAD = 25;
const MIN_MOVE = 0.002;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!MEMORY.has(key)){

    MEMORY.set(key,{
      signals:[],
      prices:[],
      stats:{
        goodMissed:0,
        badMissed:0,
        adjustment:1
      }
    });

  }

  return MEMORY.get(key);
}

/* ======================================================
RECORD MARKET PRICE
====================================================== */

function recordPrice({
  tenantId,
  price
}){

  const state = getState(tenantId);

  state.prices.push({
    price,
    ts:Date.now()
  });

  if(state.prices.length > 400)
    state.prices.shift();

}

/* ======================================================
RECORD SKIPPED SIGNAL
====================================================== */

function recordSignal({
  tenantId,
  action,
  price,
  edge,
  confidence
}){

  const state = getState(tenantId);

  state.signals.push({
    action,
    price,
    edge,
    confidence,
    ts:Date.now(),
    evaluated:false
  });

  if(state.signals.length > MAX_SIGNALS)
    state.signals.shift();

}

/* ======================================================
EVALUATE MISSED TRADES
====================================================== */

function evaluateSignals({
  tenantId
}){

  const state = getState(tenantId);

  const prices = state.prices;

  if(prices.length < LOOKAHEAD)
    return [];

  const current = prices[prices.length-1].price;

  const results = [];

  for(const s of state.signals){

    if(s.evaluated)
      continue;

    const diff = (current - s.price) / s.price;

    let pnl = 0;

    if(s.action === "BUY")
      pnl = diff;

    if(s.action === "SELL")
      pnl = -diff;

    if(Math.abs(diff) < MIN_MOVE)
      continue;

    const good = pnl > 0;

    if(good)
      state.stats.goodMissed++;
    else
      state.stats.badMissed++;

    results.push({
      action:s.action,
      edge:s.edge,
      confidence:s.confidence,
      pnl
    });

    s.evaluated = true;

  }

  adaptLearning(state);

  return results;

}

/* ======================================================
ADAPT LEARNING
====================================================== */

function adaptLearning(state){

  const good = state.stats.goodMissed;
  const bad = state.stats.badMissed;

  const total = good + bad;

  if(total < 5)
    return;

  const accuracy = good / total;

  if(accuracy > 0.6){

    state.stats.adjustment =
      Math.min(state.stats.adjustment * 1.05,1.5);

  }

  if(accuracy < 0.4){

    state.stats.adjustment =
      Math.max(state.stats.adjustment * 0.95,0.7);

  }

}

/* ======================================================
STRATEGY ADJUSTMENT
====================================================== */

function getLearningAdjustment({
  tenantId
}){

  const state = getState(tenantId);

  return state.stats.adjustment || 1;

}

module.exports={
  recordPrice,
  recordSignal,
  evaluateSignals,
  getLearningAdjustment
};
