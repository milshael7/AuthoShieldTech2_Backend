// ==========================================================
// STRATEGY ENGINE — INSTITUTIONAL MOMENTUM ENTRY v4
// PURPOSE
// Detect strong entry zones near tops/bottoms
// and avoid mid-move trades
// ==========================================================

const fs = require("fs");
const path = require("path");

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

  if(!PRICE_MEMORY.has(key)){
    PRICE_MEMORY.set(key,[]);
  }

  const arr = PRICE_MEMORY.get(key);

  arr.push(price);

  if(arr.length > 30)
    arr.shift();

  return arr;

}

/* =========================================================
BOTTOM / TOP DETECTION
========================================================= */

function detectBottom(prices){

  if(prices.length < 6)
    return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-4];
  const c = prices[prices.length-2];

  return a > b && b < c;

}

function detectTop(prices){

  if(prices.length < 6)
    return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-4];
  const c = prices[prices.length-2];

  return a < b && b > c;

}

/* =========================================================
MOMENTUM MEMORY
========================================================= */

const MOMENTUM_MEMORY = new Map();

function getMomentum(tenantId){

  const key = tenantId || "__default__";

  if(!MOMENTUM_MEMORY.has(key)){

    MOMENTUM_MEMORY.set(key,{
      momentum:0
    });

  }

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
    mem.momentum * 0.82 +
    rawMomentum * 0.18;

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
    return 0.32;

  let base = Math.abs(edge) * 16;

  if(regime==="trend")
    base *= 1.08;

  if(regime==="range")
    base *= 0.92;

  if(regime==="expansion")
    base *= 1.20;

  return clamp(base,0.05,1);

}

/* =========================================================
REGIME NORMALIZER
========================================================= */

function normalizeRegime(regime){

  if(regime === "volatility_expansion")
    return "expansion";

  return regime;

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

  const bottomDetected =
    detectBottom(prices);

  const topDetected =
    detectTop(prices);

  let regime =
    regimeMemory.detectRegime({
      price,
      lastPrice,
      volatility
    });

  regime = normalizeRegime(regime);

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

  const missedBoost =
    counterfactualEngine.getLearningAdjustment?.({
      tenantId
    }) || 1;

  confidence *= missedBoost;
  edge *= missedBoost;

  edge = clamp(edge,-0.07,0.07);
  confidence = clamp(confidence,0.05,1);

  /* =========================================================
     ENTRY LOGIC
  ========================================================= */

  if(bottomDetected && edge > 0){

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

  if(topDetected && edge < 0){

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
