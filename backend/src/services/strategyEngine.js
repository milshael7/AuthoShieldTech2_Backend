// ==========================================================
// STRATEGY ENGINE — INSTITUTIONAL MOMENTUM ENTRY v8
// PURPOSE
// Smart top/bottom detection with market structure awareness
// Detect trend shifts and avoid mid-move entries
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

  if(arr.length > 120)
    arr.shift();

  return arr;

}

/* =========================================================
SUPPORT / RESISTANCE MEMORY
========================================================= */

const LEVEL_MEMORY = new Map();

function getLevels(tenantId){

  const key = tenantId || "__default__";

  if(!LEVEL_MEMORY.has(key)){

    LEVEL_MEMORY.set(key,{
      support:[],
      resistance:[]
    });

  }

  return LEVEL_MEMORY.get(key);

}

function recordSupport(tenantId,price){

  const levels = getLevels(tenantId);

  levels.support.push(price);

  if(levels.support.length > 30)
    levels.support.shift();

}

function recordResistance(tenantId,price){

  const levels = getLevels(tenantId);

  levels.resistance.push(price);

  if(levels.resistance.length > 30)
    levels.resistance.shift();

}

function nearSupport(tenantId,price){

  const levels = getLevels(tenantId);

  return levels.support.some(
    s => Math.abs(price-s)/s < 0.002
  );

}

function nearResistance(tenantId,price){

  const levels = getLevels(tenantId);

  return levels.resistance.some(
    r => Math.abs(price-r)/r < 0.002
  );

}

/* =========================================================
MARKET STRUCTURE DETECTION
========================================================= */

function detectMarketStructure(prices){

  if(prices.length < 20)
    return "neutral";

  const recent = prices.slice(-20);

  let highs = 0;
  let lows = 0;

  for(let i=2;i<recent.length;i++){

    if(recent[i] > recent[i-1] && recent[i-1] > recent[i-2])
      highs++;

    if(recent[i] < recent[i-1] && recent[i-1] < recent[i-2])
      lows++;

  }

  if(highs > lows * 1.5)
    return "uptrend";

  if(lows > highs * 1.5)
    return "downtrend";

  return "range";

}

/* =========================================================
TOP / BOTTOM DETECTION
========================================================= */

function detectBottom(prices){

  if(prices.length < 8)
    return false;

  const a = prices[prices.length-8];
  const b = prices[prices.length-6];
  const c = prices[prices.length-4];
  const d = prices[prices.length-2];

  return a > b && b >= c && c < d;

}

function detectTop(prices){

  if(prices.length < 8)
    return false;

  const a = prices[prices.length-8];
  const b = prices[prices.length-6];
  const c = prices[prices.length-4];
  const d = prices[prices.length-2];

  return a < b && b <= c && c > d;

}

/* =========================================================
MOVE EXTENSION DETECTION
========================================================= */

function moveTooExtended(prices){

  if(prices.length < 12)
    return false;

  const first = prices[prices.length-12];
  const last  = prices[prices.length-1];

  const move = Math.abs(last-first)/first;

  return move > 0.004;

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
    mem.momentum * 0.78 +
    rawMomentum * 0.22;

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

  const structure =
    detectMarketStructure(prices);

  const bottomDetected =
    detectBottom(prices);

  const topDetected =
    detectTop(prices);

  if(bottomDetected)
    recordSupport(tenantId,price);

  if(topDetected)
    recordResistance(tenantId,price);

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

  /* =========================================================
     BUY FROM BOTTOM
  ========================================================= */

  if(
    bottomDetected &&
    nearSupport(tenantId,price) &&
    edge > 0.002 &&
    structure !== "downtrend"
  ){

    return{
      symbol,
      action:"BUY",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      regime,
      structure,
      ts:Date.now()
    };

  }

  /* =========================================================
     SELL FROM TOP
  ========================================================= */

  if(
    topDetected &&
    nearResistance(tenantId,price) &&
    edge < -0.002 &&
    structure !== "uptrend"
  ){

    return{
      symbol,
      action:"SELL",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      regime,
      structure,
      ts:Date.now()
    };

  }

  return{
    action:"WAIT",
    confidence,
    edge,
    structure
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
