// ==========================================================
// backend/src/services/regimeMemory.js
// Institutional Market Regime Engine v4
//
// Detects:
// ✔ trend
// ✔ range
// ✔ compression
// ✔ volatility expansion
// ✔ dead markets
//
// NEW:
// ✔ regime prediction
// ✔ volatility shock detection
// ✔ breakout probability modeling
// ==========================================================

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const REGIMES = new Map();

const MIN_TRADES = 6;
const MAX_TENANTS = 200;

const DECAY = 0.995;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!REGIMES.has(key)){

    if(REGIMES.size > MAX_TENANTS)
      REGIMES.clear();

    REGIMES.set(key,{
      regimes:{},
      lastRegime:"neutral",
      volatilityMemory:[]
    });

  }

  return REGIMES.get(key);

}

/* ======================================================
VOLATILITY MEMORY
====================================================== */

function recordVolatility(tenantId,volatility){

  const state = getState(tenantId);

  const arr = state.volatilityMemory;

  arr.push(volatility);

  if(arr.length > 30)
    arr.shift();

}

/* ======================================================
VOLATILITY SHOCK DETECTION
====================================================== */

function detectVolatilityShock(state,volatility){

  const arr = state.volatilityMemory;

  if(arr.length < 10)
    return false;

  const avg =
    arr.reduce((a,b)=>a+b,0)/arr.length;

  if(volatility > avg * 1.8)
    return true;

  return false;

}

/* ======================================================
DETECT CURRENT REGIME
====================================================== */

function detectRegime({
  tenantId,
  price,
  lastPrice,
  volatility
}){

  const state = getState(tenantId);

  recordVolatility(tenantId,volatility);

  if(!lastPrice)
    return "neutral";

  const move =
    Math.abs((price-lastPrice)/lastPrice);

  const shock =
    detectVolatilityShock(state,volatility);

  /* DEAD MARKET */

  if(volatility < 0.001 && move < 0.0005)
    return "dead_market";

  /* VOLATILITY SHOCK */

  if(shock)
    return "volatility_shock";

  /* VOLATILITY EXPANSION */

  if(volatility > 0.01 && move > 0.006)
    return "volatility_expansion";

  /* TREND */

  if(move > volatility * 1.2)
    return "trend";

  /* COMPRESSION */

  if(move < volatility * 0.25)
    return "compression";

  /* RANGE */

  return "range";

}

/* ======================================================
REGIME PREDICTION
Predict next likely regime
====================================================== */

function predictNextRegime({
  tenantId,
  volatility
}){

  const state = getState(tenantId);

  const arr = state.volatilityMemory;

  if(arr.length < 10)
    return "unknown";

  const avg =
    arr.reduce((a,b)=>a+b,0)/arr.length;

  const recent =
    arr[arr.length-1];

  /* compression likely breakout */

  if(recent < avg * 0.6)
    return "compression_breakout";

  /* rising volatility */

  if(recent > avg * 1.3)
    return "volatility_expansion";

  return "range_continuation";

}

/* ======================================================
RECORD TRADE RESULT
====================================================== */

function recordTrade({
  tenantId,
  regime,
  profit
}){

  const state = getState(tenantId);

  if(!state.regimes[regime]){

    state.regimes[regime]={
      wins:0,
      losses:0
    };

  }

  const r = state.regimes[regime];

  /* decay old memory */

  r.wins *= DECAY;
  r.losses *= DECAY;

  if(profit > 0)
    r.wins++;
  else
    r.losses++;

}

/* ======================================================
REGIME BOOST
====================================================== */

function getRegimeBoost({
  tenantId,
  regime
}){

  const state = getState(tenantId);

  const r = state.regimes[regime];

  if(!r)
    return 1;

  const total = r.wins + r.losses;

  if(total < MIN_TRADES)
    return 1;

  const winRate = r.wins / total;

  if(winRate > 0.65)
    return clamp(1 + (winRate - 0.5)*1.2 ,1,1.8);

  if(winRate < 0.40)
    return 0.75;

  return 1;

}

/* ======================================================
REGIME CONFIDENCE
====================================================== */

function getRegimeConfidence({
  tenantId,
  regime
}){

  const state = getState(tenantId);

  const r = state.regimes[regime];

  if(!r)
    return 0.5;

  const total = r.wins + r.losses;

  if(total < MIN_TRADES)
    return 0.5;

  return clamp(r.wins/total,0.2,0.9);

}

module.exports={
  detectRegime,
  predictNextRegime,
  recordTrade,
  getRegimeBoost,
  getRegimeConfidence
};
