// backend/src/services/counterfactualEngine.js
// Counterfactual Learning Engine
// Learns from signals that were not executed

const MEMORY = new Map();

const MAX_SIGNALS = 200;
const LOOKAHEAD = 25; // ticks to evaluate outcome

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!MEMORY.has(key)){
    MEMORY.set(key,{
      signals:[],
      prices:[]
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

    if(Math.abs(diff) > 0.002){

      results.push({
        action:s.action,
        edge:s.edge,
        confidence:s.confidence,
        pnl
      });

      s.evaluated = true;

    }

  }

  return results;

}

module.exports={
  recordPrice,
  recordSignal,
  evaluateSignals
};
