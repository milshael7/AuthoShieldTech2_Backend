// backend/src/services/orderFlowEngine.js
// Institutional Order Flow Engine — Stable v2

const FLOW = new Map();

const MAX_MEMORY = 120;
const MAX_TENANTS = 200;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!FLOW.has(key)){

    if(FLOW.size > MAX_TENANTS)
      FLOW.clear();

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

function analyzeFlow({ tenantId, price }){

  const state = getState(tenantId);

  /* automatically record price */

  if(Number.isFinite(price)){
    recordPrice({ tenantId, price });
  }

  const prices = state.prices;

  if(prices.length < 8)
    return { type:"neutral", boost:1 };

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = (last-first)/first;

  let max = first;
  let min = first;

  for(const p of prices){

    if(p.price > max) max = p.price;
    if(p.price < min) min = p.price;

  }

  const range = (max-min)/first;

  /* ================= VELOCITY ================= */

  let velocity = 0;

  for(let i=1;i<prices.length;i++){

    const prev = prices[i-1].price;
    const cur = prices[i].price;

    velocity += (cur-prev)/prev;

  }

  velocity = velocity/(prices.length-1);

  state.velocity = velocity;

  const absMove = Math.abs(move);
  const absVel = Math.abs(velocity);

  /* ================= VOLATILITY SHOCK ================= */

  if(absMove > 0.018){

    return {
      type:"volatility_shock",
      boost:0.5,
      velocity
    };

  }

  /* ================= LIQUIDITY SWEEP ================= */

  if(range > 0.009 && absMove < 0.002){

    return {
      type:"liquidity_sweep",
      boost:0.7,
      velocity
    };

  }

  /* ================= AGGRESSIVE TREND ================= */

  if(absMove > 0.006 && absVel > 0.00045){

    return {
      type:"aggressive_trend",
      boost:1.3,
      velocity
    };

  }

  /* ================= TREND ACCELERATION ================= */

  if(absVel > 0.0009){

    return {
      type:"trend_acceleration",
      boost:1.18,
      velocity
    };

  }

  /* ================= TREND EXHAUSTION ================= */

  if(absMove > 0.007 && absVel < 0.0002){

    return {
      type:"trend_exhaustion",
      boost:0.75,
      velocity
    };

  }

  /* ================= FAKE BREAKOUT ================= */

  if(range > 0.007 && absMove < 0.001){

    return {
      type:"fake_breakout",
      boost:0.65,
      velocity
    };

  }

  /* ================= MARKET COMPRESSION ================= */

  if(range < 0.0013){

    return {
      type:"compression",
      boost:1.12,
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
