// backend/src/services/orderFlowEngine.js
// Phase 1 — Order Flow Behavior Engine
// Detects liquidity sweeps, fake breakouts, and aggressive trends

const FLOW = new Map();

const MAX_MEMORY = 80;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!FLOW.has(key)){
    FLOW.set(key,{
      prices:[]
    });
  }

  return FLOW.get(key);
}

/* ======================================================
RECORD PRICE
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

  if(state.prices.length > MAX_MEMORY)
    state.prices.shift();

}

/* ======================================================
FLOW ANALYSIS
====================================================== */

function analyzeFlow({
  tenantId
}){

  const state = getState(tenantId);

  const prices = state.prices;

  if(prices.length < 6)
    return {type:"neutral",boost:1};

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = (last-first)/first;

  const max = Math.max(...prices.map(p=>p.price));
  const min = Math.min(...prices.map(p=>p.price));

  const range = (max-min)/first;

  /* ===================================================
  LIQUIDITY SWEEP
  ==================================================== */

  if(range > 0.01 && Math.abs(move) < 0.002){

    return {
      type:"liquidity_sweep",
      boost:0.7
    };

  }

  /* ===================================================
  AGGRESSIVE TREND
  ==================================================== */

  if(Math.abs(move) > 0.006){

    return {
      type:"aggressive_trend",
      boost:1.3
    };

  }

  /* ===================================================
  FAKE BREAKOUT
  ==================================================== */

  if(range > 0.008 && Math.abs(move) < 0.001){

    return {
      type:"fake_breakout",
      boost:0.6
    };

  }

  return {
    type:"neutral",
    boost:1
  };

}

module.exports={
  recordPrice,
  analyzeFlow
};
