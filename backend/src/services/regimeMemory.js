// backend/src/services/regimeMemory.js
// Market Regime Memory Engine — Stable v2
// Improvements:
// - memory safety
// - learning decay
// - faster regime detection

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const REGIMES = new Map();

const MIN_TRADES = 6;
const MAX_TENANTS = 200;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!REGIMES.has(key)){

    /* prevent memory growth */

    if(REGIMES.size > MAX_TENANTS)
      REGIMES.clear();

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

  /* volatility expansion */

  if(volatility > 0.01 && move > 0.006)
    return "volatility_expansion";

  /* directional trend */

  if(move > volatility * 1.2)
    return "trend";

  /* compression / low movement */

  if(move < volatility * 0.35)
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

  /* decay old memory so learning adapts */

  r.wins *= 0.995;
  r.losses *= 0.995;

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

  const total = r.wins + r.losses;

  if(total < MIN_TRADES)
    return 1;

  const winRate = r.wins / total;

  if(winRate > 0.6)
    return clamp(1+(winRate-0.5),1,1.6);

  if(winRate < 0.4)
    return 0.8;

  return 1;

}

module.exports={
  detectRegime,
  recordTrade,
  getRegimeBoost
};
