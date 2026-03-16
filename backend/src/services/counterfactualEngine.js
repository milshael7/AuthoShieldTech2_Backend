// backend/src/services/counterfactualEngine.js
// Counterfactual Learning Engine v4
// Self-Optimizing Strategy Intelligence

const MEMORY = new Map();

const MAX_SIGNALS = 250;
const MAX_PRICES = 500;

const LOOKAHEAD = 25;
const MIN_MOVE = 0.002;

const DECAY = 0.995;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!MEMORY.has(key)){

    MEMORY.set(key,{
      signals:[],
      prices:[],
      setups:{},
      stats:{
        goodMissed:0,
        badMissed:0,
        avgMove:0,
        adjustment:1
      }
    });

  }

  return MEMORY.get(key);

}

/* ======================================================
VOLATILITY BUCKET
====================================================== */

function getVolBucket(vol){

  if(vol > 0.01) return "high";
  if(vol > 0.005) return "mid";

  return "low";

}

/* ======================================================
SETUP KEY
====================================================== */

function getSetupKey({
  action,
  volatility,
  regime
}){

  const bucket =
    getVolBucket(volatility || 0);

  return `${action}_${bucket}_${regime || "unknown"}`;

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

  if(state.prices.length > MAX_PRICES)
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
  confidence,
  volatility,
  regime
}){

  const state = getState(tenantId);

  const setupKey =
    getSetupKey({
      action,
      volatility,
      regime
    });

  state.signals.push({
    action,
    price,
    edge,
    confidence,
    volatility,
    regime,
    setupKey,
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

  const current =
    prices[prices.length-1].price;

  const results = [];

  for(const s of state.signals){

    if(s.evaluated)
      continue;

    const diff =
      (current - s.price) / s.price;

    let pnl = 0;

    if(s.action === "BUY")
      pnl = diff;

    if(s.action === "SELL")
      pnl = -diff;

    if(Math.abs(diff) < MIN_MOVE)
      continue;

    const good =
      pnl > 0;

    if(good)
      state.stats.goodMissed++;
    else
      state.stats.badMissed++;

    state.stats.avgMove =
      state.stats.avgMove * DECAY +
      Math.abs(diff) * (1-DECAY);

    updateSetupStats(
      state,
      s.setupKey,
      pnl
    );

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
SETUP STATS
====================================================== */

function updateSetupStats(
  state,
  setupKey,
  pnl
){

  if(!state.setups[setupKey]){

    state.setups[setupKey]={
      wins:0,
      losses:0
    };

  }

  const s =
    state.setups[setupKey];

  s.wins *= DECAY;
  s.losses *= DECAY;

  if(pnl > 0)
    s.wins++;
  else
    s.losses++;

}

/* ======================================================
ADAPT LEARNING
====================================================== */

function adaptLearning(state){

  const good =
    state.stats.goodMissed;

  const bad =
    state.stats.badMissed;

  const total =
    good + bad;

  if(total < 8)
    return;

  const accuracy =
    good / total;

  if(accuracy > 0.62){

    state.stats.adjustment =
      Math.min(
        state.stats.adjustment * 1.06,
        1.7
      );

  }

  if(accuracy < 0.40){

    state.stats.adjustment =
      Math.max(
        state.stats.adjustment * 0.94,
        0.65
      );

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

/* ======================================================
SETUP EDGE BOOST
====================================================== */

function getSetupBoost({
  tenantId,
  action,
  volatility,
  regime
}){

  const state = getState(tenantId);

  const key =
    getSetupKey({
      action,
      volatility,
      regime
    });

  const s =
    state.setups[key];

  if(!s)
    return 1;

  const total =
    s.wins + s.losses;

  if(total < 6)
    return 1;

  const winRate =
    s.wins / total;

  if(winRate > 0.65)
    return 1.18;

  if(winRate < 0.40)
    return 0.82;

  return 1;

}

module.exports={
  recordPrice,
  recordSignal,
  evaluateSignals,
  getLearningAdjustment,
  getSetupBoost
};
