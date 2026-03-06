// backend/src/services/orderFlowEngine.js
// ======================================================
// Phase 2 — Institutional Order Flow Engine
// Detects liquidity sweeps, fake breakouts,
// trend acceleration, and market compression
// ======================================================

const FLOW = new Map();

const MAX_MEMORY = 120;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!FLOW.has(key)){
    FLOW.set(key,{
      prices:[],
      velocity:0
    });
  }

  return FLOW.get(key);

}

/* ======================================================
UTIL
====================================================== */

function safeNum(n,fallback=0){

  const v = Number(n);

  return Number.isFinite(v) ? v : fallback;

}

/* ======================================================
RECORD PRICE
====================================================== */

function recordPrice({
  tenantId,
  price
}){

  const state = getState(tenantId);

  const p = safeNum(price);

  state.prices.push({
    price:p,
    ts:Date.now()
  });

  if(state.prices.length > MAX_MEMORY)
    state.prices.shift();

}

/* ======================================================
FLOW ANALYSIS
====================================================== */

function analyzeFlow({ tenantId }){

  const state = getState(tenantId);
  const prices = state.prices;

  if(prices.length < 8)
    return { type:"neutral", boost:1 };

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = (last-first)/first;

  const max = Math.max(...prices.map(p=>p.price));
  const min = Math.min(...prices.map(p=>p.price));

  const range = (max-min)/first;

  /* ===================================================
  VELOCITY
  ==================================================== */

  const diffs = [];

  for(let i=1;i<prices.length;i++){

    const prev = prices[i-1].price;
    const cur = prices[i].price;

    diffs.push((cur-prev)/prev);

  }

  const velocity =
    diffs.reduce((a,b)=>a+b,0)/diffs.length;

  state.velocity = velocity;

  /* ===================================================
  LIQUIDITY SWEEP
  ==================================================== */

  if(range > 0.01 && Math.abs(move) < 0.002){

    return {
      type:"liquidity_sweep",
      boost:0.65,
      velocity
    };

  }

  /* ===================================================
  AGGRESSIVE TREND
  ==================================================== */

  if(Math.abs(move) > 0.007 && Math.abs(velocity) > 0.0005){

    return {
      type:"aggressive_trend",
      boost:1.35,
      velocity
    };

  }

  /* ===================================================
  TREND ACCELERATION
  ==================================================== */

  if(Math.abs(velocity) > 0.001){

    return {
      type:"trend_acceleration",
      boost:1.2,
      velocity
    };

  }

  /* ===================================================
  FAKE BREAKOUT
  ==================================================== */

  if(range > 0.008 && Math.abs(move) < 0.001){

    return {
      type:"fake_breakout",
      boost:0.6,
      velocity
    };

  }

  /* ===================================================
  MARKET COMPRESSION
  ==================================================== */

  if(range < 0.0015){

    return {
      type:"compression",
      boost:1.15,
      velocity
    };

  }

  return {
    type:"neutral",
    boost:1,
    velocity
  };

}

module.exports={
  recordPrice,
  analyzeFlow
};
