// ==========================================================
// STRATEGY ENGINE — INSTITUTIONAL MULTI-STRATEGY CORE v13
// Adds Institutional Risk Allocation Engine
// ==========================================================

const patternEngine = require("./patternEngine");
const regimeMemory = require("./regimeMemory");
const orderFlowEngine = require("./orderFlowEngine");
const correlationEngine = require("./correlationEngine");
const counterfactualEngine = require("./counterfactualEngine");

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

/* =========================================================
CONFIG
========================================================= */

const BASE_CONFIG = Object.freeze({
  baseRiskPct:Number(process.env.TRADE_BASE_RISK || 0.01),
  maxRiskPct:0.03,
  minRiskPct:0.002
});

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_MEMORY = new Map();
const STRUCTURE_MEMORY = new Map();

function updatePriceMemory(tenantId,price){

  const key = tenantId || "__default__";

  if(!PRICE_MEMORY.has(key))
    PRICE_MEMORY.set(key,[]);

  const arr = PRICE_MEMORY.get(key);

  arr.push(price);

  if(arr.length > 250)
    arr.shift();

  return arr;
}

/* =========================================================
STRUCTURE STATE
========================================================= */

function getStructureState(tenantId){

  const key = tenantId || "__default__";

  if(!STRUCTURE_MEMORY.has(key)){

    STRUCTURE_MEMORY.set(key,{
      lastHigh:null,
      lastLow:null,
      structure:"neutral"
    });

  }

  return STRUCTURE_MEMORY.get(key);
}

/* =========================================================
SWING DETECTION
========================================================= */

function detectSwingLow(prices){

  if(prices.length < 6) return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  return a>b && b>c && c<d && d<=e && e<=f;
}

function detectSwingHigh(prices){

  if(prices.length < 6) return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  return a<b && b<c && c>d && d>=e && e>=f;
}

/* =========================================================
STRUCTURE UPDATE
========================================================= */

function updateStructure(tenantId,price,swingHigh,swingLow){

  const s = getStructureState(tenantId);

  if(swingHigh){

    if(s.lastHigh && price > s.lastHigh)
      s.structure="HH";
    else if(s.lastHigh && price < s.lastHigh)
      s.structure="LH";

    s.lastHigh = price;
  }

  if(swingLow){

    if(s.lastLow && price > s.lastLow)
      s.structure="HL";
    else if(s.lastLow && price < s.lastLow)
      s.structure="LL";

    s.lastLow = price;
  }

  return s.structure;
}

/* =========================================================
TREND DETECTION
========================================================= */

function detectTrend(prices,len){

  if(prices.length < len)
    return "neutral";

  const a = prices[prices.length-len];
  const b = prices[prices.length-1];

  if(b>a) return "up";
  if(b<a) return "down";

  return "neutral";
}

/* =========================================================
LIQUIDITY SWEEP
========================================================= */

function detectLiquiditySweep(prices){

  if(prices.length < 8) return false;

  const prevHigh =
    Math.max(...prices.slice(-8,-2));

  const prevLow =
    Math.min(...prices.slice(-8,-2));

  const last = prices[prices.length-1];
  const prev = prices[prices.length-2];

  if(prev > prevHigh && last < prev)
    return "bearish";

  if(prev < prevLow && last > prev)
    return "bullish";

  return false;
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
EDGE MODEL
========================================================= */

function computeEdge({price,lastPrice,volatility,regime}){

  if(!lastPrice) return 0;

  const rawMomentum =
    (price-lastPrice)/lastPrice;

  let normalized =
    rawMomentum/(volatility || 0.002);

  if(regime==="trend")
    normalized *= 1.25;

  if(regime==="range")
    normalized *= 0.80;

  if(regime==="volatility_expansion")
    normalized *= 1.35;

  return clamp(normalized,-0.07,0.07);
}

/* =========================================================
CONFIDENCE
========================================================= */

function computeConfidence(edge){

  return clamp(Math.abs(edge)*18,0.05,1);

}

/* =========================================================
RISK ALLOCATION ENGINE
========================================================= */

function computeRisk({
  confidence,
  volatility,
  regime
}){

  let risk =
    BASE_CONFIG.baseRiskPct;

  /* confidence scaling */

  if(confidence > 0.85)
    risk *= 2.4;
  else if(confidence > 0.70)
    risk *= 1.7;
  else if(confidence > 0.55)
    risk *= 1.2;
  else
    risk *= 0.6;

  /* volatility protection */

  if(volatility > 0.01)
    risk *= 0.6;

  if(volatility > 0.015)
    risk *= 0.4;

  /* regime adjustment */

  if(regime==="range")
    risk *= 0.7;

  if(regime==="volatility_expansion")
    risk *= 0.75;

  return clamp(
    risk,
    BASE_CONFIG.minRiskPct,
    BASE_CONFIG.maxRiskPct
  );
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
    volatility
  } = context;

  const prices =
    updatePriceMemory(tenantId,price);

  const swingLow =
    detectSwingLow(prices);

  const swingHigh =
    detectSwingHigh(prices);

  const structure =
    updateStructure(
      tenantId,
      price,
      swingHigh,
      swingLow
    );

  const liquiditySweep =
    detectLiquiditySweep(prices);

  const microTrend =
    detectTrend(prices,5);

  const macroTrend =
    detectTrend(prices,80);

  const regime =
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
    computeConfidence(edge);

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

  const riskPct =
    computeRisk({
      confidence,
      volatility,
      regime
    });

  /* ================= BUY ================= */

  if(
    swingLow &&
    structure==="HL" &&
    macroTrend!=="down" &&
    microTrend==="up"
  ){

    return{
      symbol,
      action:"BUY",
      confidence,
      edge,
      riskPct,
      ts:Date.now()
    };

  }

  /* ================= SELL ================= */

  if(
    swingHigh &&
    structure==="LH" &&
    macroTrend!=="up" &&
    microTrend==="down"
  ){

    return{
      symbol,
      action:"SELL",
      confidence,
      edge,
      riskPct,
      ts:Date.now()
    };

  }

  /* ================= LIQUIDITY REVERSAL ================= */

  if(liquiditySweep==="bullish"){

    return{
      symbol,
      action:"BUY",
      confidence:confidence*0.9,
      edge:0.003,
      riskPct,
      ts:Date.now()
    };

  }

  if(liquiditySweep==="bearish"){

    return{
      symbol,
      action:"SELL",
      confidence:confidence*0.9,
      edge:-0.003,
      riskPct,
      ts:Date.now()
    };

  }

  return{
    action:"WAIT",
    confidence,
    edge
  };

}

function makeDecision(context){
  return buildDecision(context);
}

module.exports={
  buildDecision,
  makeDecision
};
