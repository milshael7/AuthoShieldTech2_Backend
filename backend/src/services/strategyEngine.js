// ==========================================================
// STRATEGY ENGINE — INSTITUTIONAL STRUCTURE ENGINE v11
// Detects:
// ✔ swing highs / lows
// ✔ liquidity sweeps
// ✔ market structure (HH HL LH LL)
// ✔ break of structure
// ✔ change of character
// ✔ multi timeframe trends
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

  regimeTrendEdgeBoost:1.25,
  regimeRangeEdgeCut:0.80,
  regimeExpansionBoost:1.35

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

  if(arr.length > 220)
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

  return a > b && b > c && c < d && d <= e && e <= f;
}

function detectSwingHigh(prices){

  if(prices.length < 6) return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  return a < b && b < c && c > d && d >= e && e >= f;
}

/* =========================================================
MARKET STRUCTURE
========================================================= */

function updateStructure(tenantId,price,swingHigh,swingLow){

  const state = getStructureState(tenantId);

  if(swingHigh){

    if(state.lastHigh && price > state.lastHigh){

      state.structure = "HH";

    }
    else if(state.lastHigh && price < state.lastHigh){

      state.structure = "LH";

    }

    state.lastHigh = price;

  }

  if(swingLow){

    if(state.lastLow && price > state.lastLow){

      state.structure = "HL";

    }
    else if(state.lastLow && price < state.lastLow){

      state.structure = "LL";

    }

    state.lastLow = price;

  }

  return state.structure;

}

/* =========================================================
TREND DETECTION
========================================================= */

function detectTrend(prices,length){

  if(prices.length < length)
    return "neutral";

  const a = prices[prices.length-length];
  const b = prices[prices.length-1];

  if(b > a) return "up";
  if(b < a) return "down";

  return "neutral";
}

/* =========================================================
LIQUIDITY SWEEP
========================================================= */

function detectLiquiditySweep(prices){

  if(prices.length < 8) return false;

  const prevHigh =
    Math.max(...prices.slice(-8,-2));

  const last = prices[prices.length-1];

  const breakout = last > prevHigh;
  const snapBack = prices[prices.length-2] < prevHigh;

  return breakout && snapBack;
}

/* =========================================================
MOVE EXTENSION
========================================================= */

function moveTooExtended(prices){

  if(prices.length < 12) return false;

  const first = prices[prices.length-12];
  const last  = prices[prices.length-1];

  const move = Math.abs(last-first)/first;

  return move > 0.0045;
}

/* =========================================================
EDGE
========================================================= */

function computeEdge({price,lastPrice,volatility,regime}){

  if(!lastPrice) return 0;

  const rawMomentum =
    (price-lastPrice)/lastPrice;

  let normalized =
    rawMomentum/(volatility || 0.002);

  if(regime==="trend")
    normalized *= BASE_CONFIG.regimeTrendEdgeBoost;

  if(regime==="range")
    normalized *= BASE_CONFIG.regimeRangeEdgeCut;

  if(regime==="volatility_expansion")
    normalized *= BASE_CONFIG.regimeExpansionBoost;

  return clamp(normalized,-0.07,0.07);
}

/* =========================================================
CONFIDENCE
========================================================= */

function computeConfidence(edge){

  return clamp(Math.abs(edge)*18,0.05,1);

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

  const localTrend =
    detectTrend(prices,20);

  const macroTrend =
    detectTrend(prices,80);

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

  /* ================= BUY ================= */

  if(
    swingLow &&
    structure === "HL" &&
    macroTrend !== "down" &&
    microTrend === "up" &&
    edge > 0.002
  ){

    return{
      symbol,
      action:"BUY",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      ts:Date.now()
    };

  }

  /* ================= SELL ================= */

  if(
    swingHigh &&
    structure === "LH" &&
    macroTrend !== "up" &&
    microTrend === "down" &&
    edge < -0.002
  ){

    return{
      symbol,
      action:"SELL",
      confidence,
      edge,
      riskPct:BASE_CONFIG.baseRiskPct,
      ts:Date.now()
    };

  }

  /* ================= LIQUIDITY REVERSAL ================= */

  if(liquiditySweep){

    return{
      symbol,
      action:"SELL",
      confidence:confidence*0.9,
      edge:-0.003,
      riskPct:BASE_CONFIG.baseRiskPct,
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

module.exports = {
  buildDecision,
  makeDecision
};
