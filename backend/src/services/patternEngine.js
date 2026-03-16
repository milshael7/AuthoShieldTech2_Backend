// ==========================================================
// PATTERN ENGINE — Institutional Liquidity Map Engine v5
// Liquidity Pools • Stop Hunts • Liquidity Magnets
// Vacuums • Momentum Exhaustion • Trap Detection
// ==========================================================

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const PATTERN_MEMORY = new Map();

const MAX_MEMORY = 400;
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

function recordPrice({ tenantId, price }){

  const state = getState(tenantId);

  state.priceHistory.push({
    price,
    ts:Date.now()
  });

  if(state.priceHistory.length > 120)
    state.priceHistory.shift();

}

/* ======================================================
EQUAL HIGH / LOW DETECTION
====================================================== */

function detectEqualHighs(prices){

  if(prices.length < 6) return false;

  const highs =
    prices.slice(-6).map(p=>p.price);

  const max = Math.max(...highs);

  let touches = 0;

  for(const p of highs){

    if(Math.abs(p-max)/max < 0.0006)
      touches++;

  }

  return touches >= 3;

}

function detectEqualLows(prices){

  if(prices.length < 6) return false;

  const lows =
    prices.slice(-6).map(p=>p.price);

  const min = Math.min(...lows);

  let touches = 0;

  for(const p of lows){

    if(Math.abs(p-min)/min < 0.0006)
      touches++;

  }

  return touches >= 3;

}

/* ======================================================
LIQUIDITY SWEEP DETECTION
====================================================== */

function detectLiquiditySweep(prices){

  if(prices.length < 8)
    return null;

  const recent = prices.slice(-8);

  const high =
    Math.max(...recent.slice(0,6).map(p=>p.price));

  const low =
    Math.min(...recent.slice(0,6).map(p=>p.price));

  const prev = recent[6].price;
  const last = recent[7].price;

  if(prev > high && last < prev)
    return "bearish_sweep";

  if(prev < low && last > prev)
    return "bullish_sweep";

  return null;

}

/* ======================================================
LIQUIDITY MAGNET DETECTION
====================================================== */

function detectLiquidityMagnet(prices){

  if(prices.length < 20)
    return "neutral";

  const highs =
    prices.slice(-20).map(p=>p.price);

  const max =
    Math.max(...highs);

  const min =
    Math.min(...highs);

  const last =
    prices[prices.length-1].price;

  const distHigh =
    Math.abs(max-last)/last;

  const distLow =
    Math.abs(last-min)/last;

  if(distHigh < distLow)
    return "up";

  if(distLow < distHigh)
    return "down";

  return "neutral";

}

/* ======================================================
LIQUIDITY VACUUM
====================================================== */

function detectLiquidityVacuum(prices){

  if(prices.length < 10)
    return false;

  const moves=[];

  for(let i=1;i<prices.length;i++){

    moves.push(
      Math.abs(
        (prices[i].price-prices[i-1].price) /
        prices[i-1].price
      )
    );

  }

  const avg =
    moves.reduce((a,b)=>a+b,0)/moves.length;

  const lastMove =
    moves[moves.length-1];

  return lastMove > avg*2;

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

  if(strength > 0.65){

    if(bias > 0)
      return {strength,type:"bullish"};

    if(bias < 0)
      return {strength,type:"bearish"};

  }

  return {strength,type:"neutral"};

}

/* ======================================================
MOMENTUM EXHAUSTION
====================================================== */

function detectMomentumExhaustion(prices){

  if(prices.length < 5)
    return false;

  const m1 =
    prices[prices.length-1].price -
    prices[prices.length-2].price;

  const m2 =
    prices[prices.length-2].price -
    prices[prices.length-3].price;

  const m3 =
    prices[prices.length-3].price -
    prices[prices.length-4].price;

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);

}

/* ======================================================
PATTERN DETECTION
====================================================== */

function detectMarketPattern({ tenantId }){

  const state = getState(tenantId);
  const prices = state.priceHistory;

  if(prices.length < 8)
    return {type:"neutral",boost:1};

  const equalHighs =
    detectEqualHighs(prices);

  const equalLows =
    detectEqualLows(prices);

  const liquiditySweep =
    detectLiquiditySweep(prices);

  const momentum =
    analyzeMomentum(prices);

  const vacuum =
    detectLiquidityVacuum(prices);

  const magnet =
    detectLiquidityMagnet(prices);

  const exhaustion =
    detectMomentumExhaustion(prices);

  if(liquiditySweep === "bearish_sweep")
    return { type:"stop_hunt_short", boost:1.35 };

  if(liquiditySweep === "bullish_sweep")
    return { type:"stop_hunt_long", boost:1.35 };

  if(equalHighs)
    return { type:"liquidity_pool_high", boost:1.2 };

  if(equalLows)
    return { type:"liquidity_pool_low", boost:1.2 };

  if(vacuum)
    return { type:"liquidity_vacuum", boost:1.25 };

  if(exhaustion)
    return { type:"momentum_exhaustion", boost:0.9 };

  if(momentum.strength > 0.7)
    return { type:"strong_trend", boost:1.25 };

  if(magnet === "up")
    return { type:"liquidity_magnet_up", boost:1.15 };

  if(magnet === "down")
    return { type:"liquidity_magnet_down", boost:1.15 };

  return { type:"neutral", boost:1 };

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
        boost *= clamp(1+(winRate-0.5),1,1.6);

      if(winRate < 0.4)
        boost *= 0.75;

    }

  }

  const livePattern =
    detectMarketPattern({tenantId});

  boost *= livePattern.boost;

  return clamp(boost,0.6,1.9);

}

module.exports={
  recordSignal,
  recordTrade,
  recordPrice,
  getPatternEdgeBoost
};
