// ==========================================================
// STRATEGY ENGINE — INSTITUTIONAL MOMENTUM ENTRY v9
// PURPOSE
// Institutional market structure + swing trading
// Detects:
// ✔ swing highs / lows
// ✔ liquidity sweeps
// ✔ exhaustion reversals
// ✔ market structure (HH / HL / LH / LL)
// ✔ break of structure
// ==========================================================

const patternEngine = require("./patternEngine");
const regimeMemory = require("./regimeMemory");
const orderFlowEngine = require("./orderFlowEngine");
const correlationEngine = require("./correlationEngine");
const counterfactualEngine = require("./counterfactualEngine");

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

/* =========================================================
BASE CONFIG
========================================================= */

const BASE_CONFIG = Object.freeze({

  minConfidence:Number(process.env.TRADE_MIN_CONF || 0.08),
  minEdge:Number(process.env.TRADE_MIN_EDGE || 0.00002),

  baseRiskPct:Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct:Number(process.env.TRADE_MAX_RISK || 0.03),

  regimeTrendEdgeBoost:1.25,
  regimeRangeEdgeCut:0.80,
  regimeExpansionBoost:1.35

});

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_MEMORY = new Map();

function updatePriceMemory(tenantId,price){

  const key = tenantId || "__default__";

  if(!PRICE_MEMORY.has(key))
    PRICE_MEMORY.set(key,[]);

  const arr = PRICE_MEMORY.get(key);

  arr.push(price);

  if(arr.length > 150)
    arr.shift();

  return arr;

}

/* =========================================================
STRUCTURE MEMORY
========================================================= */

const STRUCTURE_MEMORY = new Map();

function getStructure(tenantId){

  const key = tenantId || "__default__";

  if(!STRUCTURE_MEMORY.has(key)){

    STRUCTURE_MEMORY.set(key,{
      lastHigh:null,
      lastLow:null,
      trend:"neutral"
    });

  }

  return STRUCTURE_MEMORY.get(key);

}

/* =========================================================
SWING LOW DETECTION
========================================================= */

function detectSwingLow(prices){

  if(prices.length < 6)
    return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  return a > b && b > c && c < d && d <= e && e <= f;

}

/* =========================================================
SWING HIGH DETECTION
========================================================= */

function detectSwingHigh(prices){

  if(prices.length < 6)
    return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  return a < b && b < c && c > d && d >= e && e >= f;

}

/* =========================================================
MARKET STRUCTURE UPDATE
========================================================= */

function updateStructure(tenantId,price,swingHigh,swingLow){

  const structure = getStructure(tenantId);

  if(swingHigh){

    if(
      structure.lastHigh &&
      price > structure.lastHigh
    ){
      structure.trend = "uptrend";
    }

    structure.lastHigh = price;
  }

  if(swingLow){

    if(
      structure.lastLow &&
      price < structure.lastLow
    ){
      structure.trend = "downtrend";
    }

    structure.lastLow = price;
  }

  return structure.trend;

}

/* =========================================================
LIQUIDITY SWEEP
========================================================= */

function detectLiquiditySweep(prices){

  if(prices.length < 8)
    return false;

  const prevHigh =
    Math.max(...prices.slice(-8,-2));

  const last = prices[prices.length-1];

  const breakout =
    last > prevHigh;

  const snapBack =
    prices[prices.length-2] < prevHigh;

  return breakout && snapBack;

}

/* =========================================================
MOVE EXTENSION FILTER
========================================================= */

function moveTooExtended(prices){

  if(prices.length < 12)
    return false;

  const first = prices[prices.length-12];
  const last  = prices[prices.length-1];

  const move = Math.abs(last-first)/first;

  return move > 0.0045;

}

/* =========================================================
MOMENTUM MEMORY
========================================================= */

const MOMENTUM_MEMORY = new Map();

function getMomentum(tenantId){

  const key = tenantId || "__default__";

  if(!MOMENTUM_MEMORY.has(key))
    MOMENTUM_MEMORY.set(key,{momentum:0});

  return MOMENTUM_MEMORY.get(key);

}

/* =========================================================
EDGE MODEL
========================================================= */

function computeEdge({price,lastPrice,volatility,regime,tenantId}){

  if(!Number.isFinite(price) ||
     !Number.isFinite(lastPrice))
    return 0;

  const vol = volatility || 0.002;

  const rawMomentum =
    (price-lastPrice)/lastPrice;

  const mem = getMomentum(tenantId);

  mem.momentum =
    mem.momentum * 0.75 +
    rawMomentum * 0.25;

  let normalized =
    mem.momentum/(vol || 0.001);

  if(regime==="trend")
    normalized *= BASE_CONFIG.regimeTrendEdgeBoost;

  if(regime==="range")
    normalized *= BASE_CONFIG.regimeRangeEdgeCut;

  if(regime==="expansion")
    normalized *= BASE_CONFIG.regimeExpansionBoost;

  return clamp(normalized,-0.07,0.07);

}

/* =========================================================
CONFIDENCE MODEL
========================================================= */

function computeConfidence({edge,ticksSeen,regime}){

  if(ticksSeen < 12)
    return 0.30;

  let base = Math.abs(edge) * 18;

  if(regime==="trend")
    base *= 1.08;

  if(regime==="range")
    base *= 0.92;

  if(regime==="expansion")
    base *= 1.25;

  return clamp(base,0.05,1);

}

/* =========================================================
CORE DECISION
========================================================= */

function buildDecision(context={}){

  const {
    tenantId,
    symbol="BTCUSDT",
    price,
    lastPrice,
    volatility,
    ticksSeen=0
  } = context;

  const prices =
    updatePriceMemory(tenantId,price);

  const swingLow =
    detectSwingLow(prices);

  const swingHigh =
    detectSwingHigh(prices);

  const liquiditySweep =
    detectLiquiditySweep(prices);

  const trend =
    updateStructure(
      tenantId,
      price,
      swingHigh,
      swingLow
    );

  let regime =
    regimeMemory.detectRegime({
      price,
      lastPrice,
      volatility
    });

  let edge =
    computeEdge({
      price,
      lastPrice,
      volatility,
      regime,
      tenantId
    });

  edge *= patternEngine.getPatternEdgeBoost({
    tenantId,
    symbol,
    volatility
  });

  edge *= regimeMemory.getRegimeBoost({
    tenantId,
    regime
  });

  edge *= correlationEngine.getCorrelationBoost({
    tenantId,
    symbol
  });

  let confidence =
    computeConfidence({
      edge,
      ticksSeen,
      regime
    });

  const flow =
    orderFlowEngine.analyzeFlow({tenantId});

  confidence *= flow.boost || 1;
  edge *= flow.boost || 1;

  const learningBoost =
    counterfactualEngine.getLearningAdjustment?.({
      tenantId
    }) || 1;

  confidence *= learningBoost;
  edge *= learningBoost;

  edge = clamp(edge,-0.07,0.07);
  confidence = clamp(confidence,0.05,1);

  if(moveTooExtended(prices))
    return {action:"WAIT",confidence,edge};

  /* BUY ONLY IN UPTREND */

  if(
    swingLow &&
    trend !== "downtrend" &&
    edge > 0.002
  ){

    return{
      symbol,
      action:"BUY",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      regime,
      ts:Date.now()
    };

  }

  /* SELL ONLY IN DOWNTREND */

  if(
    swingHigh &&
    trend !== "uptrend" &&
    edge < -0.002
  ){

    return{
      symbol,
      action:"SELL",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      regime,
      ts:Date.now()
    };

  }

  if(liquiditySweep){

    return{
      symbol,
      action:"SELL",
      confidence:confidence*0.9,
      edge:-0.003,
      riskPct:BASE_CONFIG.baseRiskPct,
      regime,
      ts:Date.now()
    };

  }

  return{
    action:"WAIT",
    confidence,
    edge
  };

}

/* =========================================================
EXPORT
========================================================= */

function makeDecision(context){
  return buildDecision(context);
}

module.exports = {
  buildDecision,
  makeDecision
};
