// backend/src/services/regimeMemory.js
// Institutional Market Regime Engine v3
// Detects trend / range / volatility / dead markets
// Adaptive learning + memory decay

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
      lastRegime:"neutral"
    });

  }

  return REGIMES.get(key);

}

/* ======================================================
DETECT REGIME
====================================================== */

function detectRegime({
  price,
  lastPrice,
  volatility
}){

  if(!lastPrice)
    return "neutral";

  const move =
    Math.abs((price-lastPrice)/lastPrice);

  /* DEAD MARKET */

  if(volatility < 0.001 && move < 0.0005)
    return "dead_market";

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

  if(profit>0)
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

  /* strong regime */

  if(winRate > 0.65)
    return clamp(1 + (winRate - 0.5)*1.2 ,1,1.8);

  /* weak regime */

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
  recordTrade,
  getRegimeBoost,
  getRegimeConfidence
};
