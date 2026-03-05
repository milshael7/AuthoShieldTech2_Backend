// backend/src/services/regimeMemory.js
// Phase 1 — Market Regime Memory Engine

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const REGIMES = new Map();

const MIN_TRADES = 8;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!REGIMES.has(key)){

    REGIMES.set(key,{
      regimes:{}
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

  if(volatility > 0.02 && move > 0.01)
    return "volatility_expansion";

  if(move > volatility*1.5)
    return "trend";

  if(move < volatility*0.4)
    return "compression";

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

  if(profit>0)
    r.wins++;
  else
    r.losses++;

}

/* ======================================================
EDGE BOOST
====================================================== */

function getRegimeBoost({
  tenantId,
  regime
}){

  const state = getState(tenantId);

  const r = state.regimes[regime];

  if(!r)
    return 1;

  const total = r.wins+r.losses;

  if(total < MIN_TRADES)
    return 1;

  const winRate = r.wins/total;

  if(winRate > 0.65)
    return clamp(1+(winRate-0.5),1,1.7);

  if(winRate < 0.4)
    return 0.75;

  return 1;

}

module.exports={
  detectRegime,
  recordTrade,
  getRegimeBoost
};
