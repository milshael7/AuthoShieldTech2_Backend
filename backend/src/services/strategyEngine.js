// backend/src/services/strategyEngine.js
// Phase 14 — Institutional Strategy Core
// Pattern + Regime + Order Flow + Correlation + Counterfactual Learning
// Advanced Regime Intelligence Added
// Tenant Safe • Deterministic • Crash Safe

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

  minConfidence:Number(process.env.TRADE_MIN_CONF || 0.62),
  minEdge:Number(process.env.TRADE_MIN_EDGE || 0.0007),

  baseRiskPct:Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct:Number(process.env.TRADE_MAX_RISK || 0.02),

  regimeTrendEdgeBoost:1.25,
  regimeRangeEdgeCut:0.75,
  regimeExpansionBoost:1.35

});

/* =========================================================
LEARNING CONFIG
========================================================= */

const LEARNING_VERSION = 5;

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

/* =========================================================
DEFAULT LEARNING STATE
========================================================= */

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

/* =========================================================
LOAD / SAVE
========================================================= */

function loadLearning(tenantId){

  const key = tenantId || "__default__";

  if(LEARNING_CACHE.has(key))
    return LEARNING_CACHE.get(key);

  const file = learningPath(key);

  let state = defaultLearning();

  try{

    if(fs.existsSync(file)){

      const raw = JSON.parse(
        fs.readFileSync(file,"utf-8")
      );

      state = {...state,...raw};

      if(state.version !== LEARNING_VERSION)
        state = defaultLearning();

    }

  }catch{}

  LEARNING_CACHE.set(key,state);

  return state;

}

function saveLearning(tenantId){

  const key = tenantId || "__default__";

  const state = LEARNING_CACHE.get(key);

  if(!state) return;

  try{

    const file = learningPath(key);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(state,null,2)
    );

    fs.renameSync(tmp,file);

  }catch{}

}

/* =========================================================
REGIME DETECTION
========================================================= */

function detectRegime({price,lastPrice,volatility}){

  return regimeMemory.detectRegime({
    price,
    lastPrice,
    volatility
  });

}

/* =========================================================
ADVANCED REGIME FILTER
========================================================= */

function refineRegime({
  regime,
  volatility,
  price,
  lastPrice
}){

  const move =
    Math.abs((price-lastPrice)/lastPrice);

  if(volatility > 0.025)
    return "volatility_shock";

  if(volatility < 0.0015 && move < 0.0005)
    return "compression";

  return regime;

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

  return clamp(normalized,-0.03,0.03);

}

/* =========================================================
CONFIDENCE MODEL
========================================================= */

function computeConfidence({edge,ticksSeen,regime}){

  if(ticksSeen < 50)
    return 0.4;

  let base = Math.abs(edge)*6;

  if(regime==="expansion")
    base *= 1.2;

  if(regime==="range")
    base *= 0.85;

  return clamp(base,0,1);

}

/* =========================================================
PERFORMANCE ADAPTATION
========================================================= */

function adaptFromPerformance(tenantId,paperState){

  if(!tenantId || !paperState?.trades)
    return;

  const learning = loadLearning(tenantId);

  const trades = paperState.trades;

  if(trades.length ===
     learning.lastEvaluatedTradeCount)
    return;

  if(trades.length < 10)
    return;

  const recent = trades.slice(-20);

  const wins =
    recent.filter(t=>t.profit>0).length;

  const losses =
    recent.filter(t=>t.profit<=0).length;

  const total = wins+losses;

  if(!total) return;

  const winRate = wins/total;

  learning.lastWinRate = winRate;

  if(winRate < 0.45){

    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier*1.06,1,2);

    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier*1.04,1,1.5);

  }

  if(winRate > 0.65){

    learning.edgeMultiplier =
      clamp(learning.edgeMultiplier*0.97,0.7,1.5);

    learning.confidenceMultiplier =
      clamp(learning.confidenceMultiplier*0.97,0.7,1.3);

  }

  learning.lastEvaluatedTradeCount =
    trades.length;

  learning.lastUpdated = Date.now();

  saveLearning(tenantId);

}

/* =========================================================
FINAL DECISION BUILDER
========================================================= */

function buildDecision(context={}){

  const {
    tenantId,
    symbol="BTCUSDT",
    price,
    lastPrice,
    volatility,
    ticksSeen=0,
    paperState=null
  } = context;

  const learning = loadLearning(tenantId);

  adaptFromPerformance(tenantId,paperState);

  /* ================= REGIME ================= */

  let regime =
    detectRegime({
      price,
      lastPrice,
      volatility
    });

  regime =
    refineRegime({
      regime,
      volatility,
      price,
      lastPrice
    });

  /* ================= EDGE ================= */

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

  /* ================= CONFIDENCE ================= */

  let confidence =
    computeConfidence({
      edge,
      ticksSeen,
      regime
    });

  /* ================= ORDER FLOW ================= */

  const flow =
    orderFlowEngine.analyzeFlow({
      tenantId
    });

  confidence *= flow.boost;
  edge *= flow.boost;

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

  edge = clamp(edge,-0.05,0.05);
  confidence = clamp(confidence,0,1);

  if(!Number.isFinite(price))
    return {action:"WAIT",confidence:0,edge:0};

  if(regime==="compression"){
    return{
      action:"WAIT",
      confidence:confidence*0.7,
      edge:0,
      regime
    };
  }

  if(confidence < BASE_CONFIG.minConfidence)
    return {action:"WAIT",confidence,edge};

  if(Math.abs(edge) < BASE_CONFIG.minEdge)
    return {action:"WAIT",confidence,edge};

  /* ================= RISK ================= */

  let riskPct =
    BASE_CONFIG.baseRiskPct * confidence;

  if(regime==="expansion")
    riskPct *= 1.4;

  if(regime==="range")
    riskPct *= 0.75;

  if(regime==="compression")
    riskPct *= 0.4;

  if(regime==="volatility_shock")
    riskPct *= 0.25;

  riskPct =
    clamp(
      riskPct,
      BASE_CONFIG.baseRiskPct,
      BASE_CONFIG.maxRiskPct
    );

  return{

    symbol,

    action:edge>0 ? "BUY":"SELL",

    confidence,
    edge,
    riskPct,

    regime,
    flow:flow.type,

    learning,

    ts:Date.now()

  };

}

module.exports={
  buildDecision
};
