// backend/src/services/orderFlowEngine.js
// ======================================================
// Phase 3 — Institutional Order Flow Engine
// Detects liquidity sweeps, fake breakouts,
// trend acceleration, compression, exhaustion
// and volatility shocks
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
      velocity:0,
      lastFlow:"neutral"
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

  const absMove = Math.abs(move);
  const absVel = Math.abs(velocity);

  /* ===================================================
  VOLATILITY SHOCK
  ==================================================== */

  if(absMove > 0.02){

    return {
      type:"volatility_shock",
      boost:0.4,
      velocity
    };

  }

  /* ===================================================
  LIQUIDITY SWEEP
  ==================================================== */

  if(range > 0.01 && absMove < 0.002){

    return {
      type:"liquidity_sweep",
      boost:0.65,
      velocity
    };

  }

  /* ===================================================
  AGGRESSIVE TREND
  ==================================================== */

  if(absMove > 0.007 && absVel > 0.0005){

    return {
      type:"aggressive_trend",
      boost:1.35,
      velocity
    };

  }

  /* ===================================================
  TREND ACCELERATION
  ==================================================== */

  if(absVel > 0.001){

    return {
      type:"trend_acceleration",
      boost:1.2,
      velocity
    };

  }

  /* ===================================================
  TREND EXHAUSTION
  ==================================================== */

  if(absMove > 0.008 && absVel < 0.0002){

    return {
      type:"trend_exhaustion",
      boost:0.7,
      velocity
    };

  }

  /* ===================================================
  FAKE BREAKOUT
  ==================================================== */

  if(range > 0.008 && absMove < 0.001){

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
