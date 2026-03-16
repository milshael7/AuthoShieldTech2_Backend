// ==========================================================
// STRATEGY ENGINE — PAPER TRADING CORE (ENHANCED v4)
// PURPOSE
// Short-duration momentum scalping engine
//
// IMPROVEMENTS
// ✔ micro-trend burst detection
// ✔ volatility-adaptive scalping
// ✔ stronger noise filtering
// ✔ improved short-duration signal confidence
// ✔ better regime weighting
// ✔ smarter learning scaling
// ✔ safer risk model
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

  minConfidence:Number(process.env.TRADE_MIN_CONF || 0.09),
  minEdge:Number(process.env.TRADE_MIN_EDGE || 0.00002),

  baseRiskPct:Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct:Number(process.env.TRADE_MAX_RISK || 0.03),

  regimeTrendEdgeBoost:1.30,
  regimeRangeEdgeCut:0.75,
  regimeExpansionBoost:1.40

});

/* =========================================================
LEARNING SYSTEM
========================================================= */

const LEARNING_VERSION = 8;

const LEARNING_DIR =
  process.env.STRATEGY_LEARNING_DIR ||
  path.join("/tmp","strategy_learning");

function ensureDir(p){
  if(!fs.existsSync(p))
    fs.mkdirSync(p,{recursive:true});
}

function learningPath(tenantId){

  ensureDir(LEARNING_DIR);

  const key = tenantId || "__default__";

  return path.join(
    LEARNING_DIR,
    `learning_${key}.json`
  );

}

function defaultLearning(){
  return{
    version:LEARNING_VERSION,
    edgeMultiplier:1,
    confidenceMultiplier:1,
    lastWinRate:0.5,
    lastEvaluatedTradeCount:0,
    lastUpdated:Date.now()
  };
}

const LEARNING_CACHE = new Map();

function loadLearning(tenantId){

  const key = tenantId || "__default__";

  if(LEARNING_CACHE.has(key))
    return LEARNING_CACHE.get(key);

  const file = learningPath(key);

  let state = defaultLearning();

  try{

    if(fs.existsSync(file)){

      const raw =
        JSON.parse(fs.readFileSync(file,"utf-8"));

      state = {...state,...raw};

      if(state.version !== LEARNING_VERSION)
        state = defaultLearning();

    }

  }catch{}

  LEARNING_CACHE.set(key,state);

  return state;

}

/* =========================================================
MOMENTUM MEMORY
========================================================= */

const MOMENTUM_MEMORY = new Map();

function getMomentum(tenantId){

  const key = tenantId || "__default__";

  if(!MOMENTUM_MEMORY.has(key)){

    MOMENTUM_MEMORY.set(key,{
      momentum:0,
      acceleration:0
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

  /* momentum smoothing */

  const prevMomentum = mem.momentum;

  mem.momentum =
    mem.momentum * 0.80 +
    rawMomentum * 0.20;

  /* acceleration detection */

  mem.acceleration =
    mem.acceleration * 0.75 +
    (mem.momentum - prevMomentum) * 0.25;

  let normalized =
    (mem.momentum + mem.acceleration) /
    (vol || 0.001);

  if(regime==="trend")
    normalized *= BASE_CONFIG.regimeTrendEdgeBoost;

  if(regime==="range")
    normalized *= BASE_CONFIG.regimeRangeEdgeCut;

  if(regime==="expansion")
    normalized *= BASE_CONFIG.regimeExpansionBoost;

  return clamp(normalized,-0.08,0.08);

}

/* =========================================================
CONFIDENCE MODEL
========================================================= */

function computeConfidence({edge,ticksSeen,regime}){

  if(ticksSeen < 12)
    return 0.34;

  let base =
    Math.abs(edge) * 18;

  if(regime==="trend")
    base *= 1.1;

  if(regime==="range")
    base *= 0.9;

  if(regime==="expansion")
    base *= 1.25;

  return clamp(base,0.06,1);

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

  const learning = loadLearning(tenantId);

  let regime =
    regimeMemory.detectRegime({
      price,
      lastPrice,
      volatility
    });

  regime = normalizeRegime(regime);

  /* ================= EDGE ================= */

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

  /* ================= CONFIDENCE ================= */

  let confidence =
    computeConfidence({
      edge,
      ticksSeen,
      regime
    });

  /* ================= ORDER FLOW ================= */

  const flow =
    orderFlowEngine.analyzeFlow({tenantId});

  confidence *= flow.boost || 1;
  edge *= flow.boost || 1;

  /* ================= COUNTERFACTUAL ================= */

  const missedBoost =
    counterfactualEngine.getLearningAdjustment?.({
      tenantId
    }) || 1;

  confidence *= missedBoost;
  edge *= missedBoost;

  /* ================= LEARNING ================= */

  edge *= learning.edgeMultiplier;
  confidence *= learning.confidenceMultiplier;

  edge = clamp(edge,-0.08,0.08);
  confidence = clamp(confidence,0.06,1);

  if(!Number.isFinite(price))
    return {action:"WAIT",confidence:0,edge:0};

  if(confidence < BASE_CONFIG.minConfidence)
    return {action:"WAIT",confidence,edge};

  if(Math.abs(edge) < BASE_CONFIG.minEdge)
    return {action:"WAIT",confidence,edge};

  /* =========================================================
     SCALPING FILTER
     Ensure strong burst moves only
  ========================================================= */

  if(Math.abs(edge) < 0.0025)
    return {action:"WAIT",confidence,edge};

  /* =========================================================
     VOLATILITY ADAPTIVE FILTER
  ========================================================= */

  if(volatility < 0.0006)
    return {action:"WAIT",confidence,edge};

  /* =========================================================
     RISK MODEL
  ========================================================= */

  let riskPct =
    BASE_CONFIG.baseRiskPct *
    (0.60 + confidence * 0.80);

  riskPct =
    clamp(
      riskPct,
      BASE_CONFIG.baseRiskPct,
      BASE_CONFIG.maxRiskPct
    );

  return{
    symbol,
    action:edge > 0 ? "BUY":"SELL",
    confidence,
    edge,
    riskPct,
    regime,
    ts:Date.now()
  };

}

/* =========================================================
COMPATIBILITY EXPORT
========================================================= */

function makeDecision(context){
  return buildDecision(context);
}

module.exports = {
  buildDecision,
  makeDecision
};
