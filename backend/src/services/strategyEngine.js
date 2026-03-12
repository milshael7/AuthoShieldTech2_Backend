// ==========================================================
// STRATEGY ENGINE — PAPER TRADING CORE (UNLOCKED)
// STABLE VERSION — Regime Fix + Signal Stability
// FIXED: confidence scaling so AI dashboard moves
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
BASE CONFIG (PAPER FRIENDLY)
========================================================= */

const BASE_CONFIG = Object.freeze({

  // Lower threshold so paper AI actually trades
  minConfidence:Number(process.env.TRADE_MIN_CONF || 0.05),

  minEdge:Number(process.env.TRADE_MIN_EDGE || 0.00005),

  baseRiskPct:Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct:Number(process.env.TRADE_MAX_RISK || 0.03),

  regimeTrendEdgeBoost:1.25,
  regimeRangeEdgeCut:0.8,
  regimeExpansionBoost:1.35

});

/* =========================================================
LEARNING SYSTEM
========================================================= */

const LEARNING_VERSION = 7;

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
EDGE MODEL
========================================================= */

function computeEdge({price,lastPrice,volatility,regime}){

  if(!Number.isFinite(price) ||
     !Number.isFinite(lastPrice))
    return 0;

  const vol = volatility || 0.002;

  const momentum =
    (price-lastPrice)/lastPrice;

  let normalized =
    momentum/(vol || 0.001);

  if(regime==="trend")
    normalized *= BASE_CONFIG.regimeTrendEdgeBoost;

  if(regime==="range")
    normalized *= BASE_CONFIG.regimeRangeEdgeCut;

  if(regime==="expansion")
    normalized *= BASE_CONFIG.regimeExpansionBoost;

  return clamp(normalized,-0.06,0.06);
}

/* =========================================================
CONFIDENCE MODEL
========================================================= */

function computeConfidence({edge,ticksSeen,regime}){

  // warmup confidence
  if(ticksSeen < 10)
    return 0.35;

  // FIXED: scaled so dashboard shows movement
  let base = Math.abs(edge) * 25;

  if(regime==="expansion")
    base *= 1.2;

  if(regime==="range")
    base *= 0.9;

  return clamp(base,0,1);
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
FINAL DECISION
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

  let edge =
    computeEdge({
      price,
      lastPrice,
      volatility,
      regime
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

  edge *= learning.edgeMultiplier;
  confidence *= learning.confidenceMultiplier;

  edge = clamp(edge,-0.06,0.06);
  confidence = clamp(confidence,0,1);

  if(!Number.isFinite(price))
    return {action:"WAIT",confidence:0,edge:0};

  /* ================= DECISION GATES ================= */

  if(confidence < BASE_CONFIG.minConfidence)
    return {action:"WAIT",confidence,edge};

  if(Math.abs(edge) < BASE_CONFIG.minEdge)
    return {action:"WAIT",confidence,edge};

  let riskPct =
    clamp(
      BASE_CONFIG.baseRiskPct * confidence,
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

module.exports = {
  buildDecision
};
