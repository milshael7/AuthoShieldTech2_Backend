// ==========================================================
// PATTERN ENGINE — Adaptive Pattern Discovery v3
// Adds candle momentum + exhaustion detection
// ==========================================================

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const PATTERN_MEMORY = new Map();

const MAX_MEMORY = 300;
const MIN_PATTERN_OCCURRENCES = 3;

/* ======================================================
STATE
====================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!PATTERN_MEMORY.has(key)){

    PATTERN_MEMORY.set(key,{
      signals:[],
      patterns:{},
      priceHistory:[]
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
PRICE MEMORY
====================================================== */

function recordPrice({
  tenantId,
  price
}){

  const state = getState(tenantId);

  state.priceHistory.push({
    price,
    ts:Date.now()
  });

  if(state.priceHistory.length > 60)
    state.priceHistory.shift();

}

/* ======================================================
MOMENTUM ANALYSIS
====================================================== */

function analyzeMomentum(prices){

  if(prices.length < 6)
    return {strength:0,type:"neutral"};

  let up = 0;
  let down = 0;

  for(let i=1;i<prices.length;i++){

    if(prices[i].price > prices[i-1].price)
      up++;

    if(prices[i].price < prices[i-1].price)
      down++;

  }

  const total = up + down;

  if(total === 0)
    return {strength:0,type:"neutral"};

  const bias = up - down;
  const strength = Math.abs(bias)/total;

  if(strength > 0.6){

    if(bias > 0)
      return {strength,type:"bullish"};

    if(bias < 0)
      return {strength,type:"bearish"};

  }

  return {strength,type:"neutral"};

}

/* ======================================================
PATTERN DETECTION
====================================================== */

function detectMarketPattern({
  tenantId
}){

  const state = getState(tenantId);

  const prices = state.priceHistory;

  if(prices.length < 6)
    return {type:"neutral",boost:1};

  const first = prices[0].price;
  const last = prices[prices.length-1].price;

  const move = (last-first)/first;

  const max = Math.max(...prices.map(p=>p.price));
  const min = Math.min(...prices.map(p=>p.price));

  const range = (max-min)/first;

  const momentum =
    analyzeMomentum(prices);

  /* ================= STRONG TREND ================= */

  if(momentum.strength > 0.7){

    return{
      type:"strong_trend",
      boost:1.35
    };

  }

  /* ================= BREAKOUT ================= */

  if(Math.abs(move) > 0.003){

    return{
      type:"breakout",
      boost:1.25
    };

  }

  /* ================= FAKE BREAKOUT ================= */

  if(range > 0.008 && Math.abs(move) < 0.0015){

    return{
      type:"fake_breakout",
      boost:0.8
    };

  }

  /* ================= REVERSAL ================= */

  if(range > 0.004 && Math.abs(move) < 0.0006){

    return{
      type:"reversal",
      boost:0.9
    };

  }

  return{
    type:"neutral",
    boost:1
  };

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

  let boost = 1;

  if(p){

    const total = p.wins + p.losses;

    if(total >= MIN_PATTERN_OCCURRENCES){

      const winRate = p.wins / total;

      if(winRate > 0.6)
        boost *= clamp(1 + (winRate - 0.5),1,1.6);

      if(winRate < 0.4)
        boost *= 0.75;

    }

  }

  /* ================= LIVE MARKET PATTERN ================= */

  const livePattern =
    detectMarketPattern({tenantId});

  boost *= livePattern.boost;

  return clamp(boost,0.6,1.8);

}

module.exports={
  recordSignal,
  recordTrade,
  recordPrice,
  getPatternEdgeBoost
};
