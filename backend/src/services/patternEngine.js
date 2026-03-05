// backend/src/services/patternEngine.js
// Phase 1 Pattern Discovery Engine
// Detects repeating profitable market patterns

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const PATTERN_MEMORY = new Map();

const MAX_MEMORY = 300;
const MIN_PATTERN_OCCURRENCES = 5;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!PATTERN_MEMORY.has(key)){

    PATTERN_MEMORY.set(key,{
      signals:[],
      patterns:{}
    });

  }

  return PATTERN_MEMORY.get(key);
}

/* ======================================================
RECORD SIGNAL
====================================================== */

function recordSignal({
  tenantId,
  symbol,
  price,
  volatility,
  action,
  confidence,
  edge
}){

  const state = getState(tenantId);

  state.signals.push({
    ts:Date.now(),
    symbol,
    price,
    volatility,
    action,
    confidence,
    edge
  });

  if(state.signals.length > MAX_MEMORY)
    state.signals.shift();

}

/* ======================================================
RECORD TRADE RESULT
====================================================== */

function recordTrade({
  tenantId,
  symbol,
  entry,
  exit,
  profit,
  volatility
}){

  const state = getState(tenantId);

  const key =
    `${symbol}_${Math.round(volatility*1000)}`;

  if(!state.patterns[key]){

    state.patterns[key]={
      wins:0,
      losses:0
    };

  }

  if(profit > 0)
    state.patterns[key].wins++;
  else
    state.patterns[key].losses++;

}

/* ======================================================
PATTERN EDGE BOOST
====================================================== */

function getPatternEdgeBoost({
  tenantId,
  symbol,
  volatility
}){

  const state = getState(tenantId);

  const key =
    `${symbol}_${Math.round(volatility*1000)}`;

  const p = state.patterns[key];

  if(!p) return 1;

  const total = p.wins + p.losses;

  if(total < MIN_PATTERN_OCCURRENCES)
    return 1;

  const winRate = p.wins / total;

  if(winRate > 0.65)
    return clamp(1 + (winRate - 0.5),1,1.8);

  if(winRate < 0.4)
    return 0.7;

  return 1;

}

module.exports={
  recordSignal,
  recordTrade,
  getPatternEdgeBoost
};
