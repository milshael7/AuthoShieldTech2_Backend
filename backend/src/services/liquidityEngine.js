// backend/src/services/liquidityEngine.js
// ======================================================
// Institutional Liquidity Intelligence Engine
// Detects stop hunts, traps, absorption, liquidity zones,
// pressure shifts, and liquidity vacuums
// ======================================================

const LIQUIDITY = new Map();

const MAX_PRICE_MEMORY = 150;
const MAX_LEVEL_MEMORY = 60;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!LIQUIDITY.has(key)){

    LIQUIDITY.set(key,{
      prices:[],
      levels:[],
      absorptionLevels:[],
      pressure:"neutral"
    });

  }

  return LIQUIDITY.get(key);

}

/* ======================================================
UTIL
====================================================== */

function safeNum(n,fallback=0){

  const v = Number(n);

  return Number.isFinite(v) ? v : fallback;

}

function clamp(n,min,max){

  return Math.max(min,Math.min(max,n));

}

/* ======================================================
ROUND NUMBER DETECTION
====================================================== */

function isRoundLevel(price){

  const p = Math.round(price);

  if(p % 100 === 0) return true;
  if(p % 50 === 0) return true;

  return false;

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

  if(state.prices.length > MAX_PRICE_MEMORY)
    state.prices.shift();

  if(isRoundLevel(p)){

    state.levels.push({
      price:p,
      strength:1
    });

    if(state.levels.length > MAX_LEVEL_MEMORY)
      state.levels.shift();

  }

}

/* ======================================================
LIQUIDITY SWEEP
====================================================== */

function detectLiquiditySweep(prices){

  if(prices.length < 10)
    return null;

  const last = prices[prices.length-1].price;

  const highs =
    prices.slice(-10).map(p=>p.price);

  const max = Math.max(...highs);
  const min = Math.min(...highs);

  if(last > max * 1.001)
    return "liquidity_sweep_up";

  if(last < min * 0.999)
    return "liquidity_sweep_down";

  return null;

}

/* ======================================================
ABSORPTION DETECTION
====================================================== */

function detectAbsorption(prices){

  if(prices.length < 12)
    return null;

  const lastPrices =
    prices.slice(-6).map(p=>p.price);

  const max = Math.max(...lastPrices);
  const min = Math.min(...lastPrices);

  const range = (max-min)/max;

  if(range < 0.0008){

    const trend =
      lastPrices[lastPrices.length-1] -
      lastPrices[0];

    if(trend > 0)
      return "sell_absorption";

    if(trend < 0)
      return "buy_absorption";

  }

  return null;

}

/* ======================================================
TRAP DETECTION
====================================================== */

function detectTrap(prices){

  if(prices.length < 12)
    return null;

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = (last-first)/first;

  const max =
    Math.max(...prices.map(p=>p.price));

  const min =
    Math.min(...prices.map(p=>p.price));

  const range = (max-min)/first;

  if(range > 0.01 && Math.abs(move) < 0.002){

    if(last > first)
      return "bull_trap";

    if(last < first)
      return "bear_trap";

  }

  return null;

}

/* ======================================================
LIQUIDITY VACUUM
====================================================== */

function detectVacuum(prices){

  if(prices.length < 6)
    return false;

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = Math.abs((last-first)/first);

  if(move > 0.012)
    return true;

  return false;

}

/* ======================================================
PRESSURE DETECTION
====================================================== */

function detectPressure(prices){

  if(prices.length < 10)
    return "neutral";

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const diff = (last-first)/first;

  if(diff > 0.003)
    return "buy";

  if(diff < -0.003)
    return "sell";

  return "neutral";

}

/* ======================================================
ANALYSIS
====================================================== */

function analyzeLiquidity({
  tenantId
}){

  const state = getState(tenantId);

  const prices = state.prices;

  if(prices.length < 12)
    return {type:"neutral",boost:1};

  const sweep = detectLiquiditySweep(prices);
  const trap = detectTrap(prices);
  const absorption = detectAbsorption(prices);
  const vacuum = detectVacuum(prices);

  const pressure = detectPressure(prices);

  state.pressure = pressure;

  /* ===================================================
  LIQUIDITY SWEEP
  ==================================================== */

  if(sweep){

    return{
      type:sweep,
      pressure,
      trap,
      boost:0.75
    };

  }

  /* ===================================================
  TRAP
  ==================================================== */

  if(trap){

    return{
      type:trap,
      pressure,
      boost:0.65
    };

  }

  /* ===================================================
  ABSORPTION
  ==================================================== */

  if(absorption){

    return{
      type:absorption,
      pressure,
      boost:0.85
    };

  }

  /* ===================================================
  VACUUM
  ==================================================== */

  if(vacuum){

    return{
      type:"liquidity_vacuum",
      pressure,
      boost:1.35
    };

  }

  return{
    type:"neutral",
    pressure,
    boost:1
  };

}

module.exports={
  recordPrice,
  analyzeLiquidity
};
