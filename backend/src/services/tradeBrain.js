// -----------------------------------------------------------
// AutoShield — Institutional Trade Brain (Global Alpha v21)
// Faster Learning Cycle + Safe Hands-On Training
// -----------------------------------------------------------

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 80);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const MAX_DRAWDOWN =
  Number(process.env.TRADE_MAX_DRAWDOWN || 0.08);

const VOLATILITY_SHUTDOWN =
  Number(process.env.TRADE_VOLATILITY_SHUTDOWN || 0.03);

const CRASH_MOVE =
  Number(process.env.TRADE_CRASH_MOVE || 0.03);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.72);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.86);

const MIN_CONFIDENCE_TO_TRADE =
  Number(process.env.TRADE_MIN_CONFIDENCE || 0.55);

const MAX_RISK = 0.06;
const MIN_RISK = 0.001;

const TRADE_COOLDOWN_MS =
  Number(process.env.TRADE_COOLDOWN_MS || 20000);

const MIN_MOMENTUM_EDGE =
  Number(process.env.TRADE_MIN_EDGE || 0.00025);

/* ================= EXPLORATION LEARNING ================= */

const EXPLORATION_RATE =
  Number(process.env.TRADE_EXPLORATION_RATE || 0.02);

const ACTIONS = new Set(["WAIT","BUY","SELL","CLOSE"]);

/* ================= STATE ================= */

const BRAIN_STATE = new Map();

function getBrainState(tenantId){

  const key = tenantId || "__default__";

  if(!BRAIN_STATE.has(key)){

    BRAIN_STATE.set(key,{
      smoothedConfidence:0.25,
      edgeMomentum:0,
      lastAction:"WAIT",
      lastDecisionTime:0,
      lastTradeTime:0,
      priceMemory:[],
      lossStreak:0,
      peakEquity:0
    });

  }

  return BRAIN_STATE.get(key);

}

/* ================= UTIL ================= */

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

/* ================= PRICE MEMORY ================= */

function updatePriceMemory(brain,price){

  brain.priceMemory.push(price);

  if(brain.priceMemory.length > 30)
    brain.priceMemory.shift();

}

/* ================= SESSION INTELLIGENCE ================= */

function getSessionBoost(){

  const hour =
    new Date().getUTCHours();

  if(hour >= 12 && hour <= 16)
    return 1.08;

  if(hour >= 7 && hour < 12)
    return 1.05;

  return 0.98;

}

/* ================= EXECUTION ALPHA ================= */

function detectExecutionAlpha(prices){

  if(prices.length < 4)
    return 1;

  const m1 =
    prices[prices.length-1] -
    prices[prices.length-2];

  const m2 =
    prices[prices.length-2] -
    prices[prices.length-3];

  if(Math.abs(m1) > Math.abs(m2)*1.3)
    return 1.05;

  return 1;

}

/* ================= CRASH DETECTION ================= */

function detectCrash(prices){

  if(prices.length < 5)
    return false;

  const first =
    prices[prices.length-5];

  const last =
    prices[prices.length-1];

  const move =
    Math.abs((last-first)/first);

  return move > CRASH_MOVE;

}

/* ================= RISK GOVERNOR ================= */

function riskGovernor({
  brain,
  paper,
  volatility,
  prices
}){

  const equity =
    safeNum(paper.cashBalance,0);

  if(!brain.peakEquity)
    brain.peakEquity = equity;

  if(equity > brain.peakEquity)
    brain.peakEquity = equity;

  const drawdown =
    (brain.peakEquity - equity) /
    brain.peakEquity;

  if(drawdown > MAX_DRAWDOWN)
    return "DRAWDOWN_LIMIT";

  if(brain.lossStreak >= MAX_LOSS_STREAK)
    return "LOSS_STREAK";

  if(volatility > VOLATILITY_SHUTDOWN)
    return "VOLATILITY_SPIKE";

  if(detectCrash(prices))
    return "CRASH_DETECTED";

  return null;

}

/* ================= DECISION ================= */

function makeDecision(context={}){

  const {
    tenantId,
    symbol="BTCUSDT",
    last,
    paper={}
  } = context;

  const brain = getBrainState(tenantId);

  const price = safeNum(last,NaN);

  updatePriceMemory(brain,price);

  const prices = brain.priceMemory;

  const volatility =
    safeNum(paper.volatility,0);

  const now = Date.now();

  const riskStop =
    riskGovernor({
      brain,
      paper,
      volatility,
      prices
    });

  if(riskStop){

    return{
      symbol,
      action:"WAIT",
      confidence:0,
      edge:0,
      riskPct:0,
      reason:riskStop,
      ts:now
    };

  }

  let strategy = {};

  try{

    strategy =
      buildDecision({
        tenantId,
        symbol,
        price,
        lastPrice:paper.lastPrice,
        volatility,
        paperState:paper
      }) || {};

  }catch{}

  let action =
    strategy.action || "WAIT";

  let confidence =
    safeNum(strategy.confidence,0.25);

  let edge =
    safeNum(strategy.edge,0);

  let riskPct =
    safeNum(strategy.riskPct,0.01);

  if(!ACTIONS.has(action))
    action="WAIT";

  if(Math.abs(edge) < MIN_MOMENTUM_EDGE)
    action="WAIT";

  /* ================= AI OVERLAY ================= */

  try{

    const ai =
      aiBrain.decide({
        tenantId,
        symbol,
        last,
        paper
      }) || {};

    confidence =
      clamp((confidence*0.7)+(safeNum(ai.confidence,0)*0.3),0,1);

    edge =
      clamp((edge*0.7)+(safeNum(ai.edge,0)*0.3),-1,1);

  }catch{}

  confidence *= getSessionBoost();
  confidence *= detectExecutionAlpha(prices);

  const decay =
    CONFIDENCE_DECAY;

  brain.smoothedConfidence =
    brain.smoothedConfidence * decay +
    confidence * (1 - decay);

  confidence =
    clamp(brain.smoothedConfidence,0,1);

  brain.edgeMomentum =
    brain.edgeMomentum * EDGE_MEMORY_DECAY +
    edge * (1 - EDGE_MEMORY_DECAY);

  edge =
    clamp(brain.edgeMomentum,-1,1);

  if(confidence < MIN_CONFIDENCE_TO_TRADE)
    action="WAIT";

  /* ================= EXPLORATION LEARNING ================= */

  if(
    action === "WAIT" &&
    Math.random() < EXPLORATION_RATE &&
    Math.abs(edge) > MIN_MOMENTUM_EDGE * 0.5
  ){

    action =
      edge > 0 ? "BUY" : "SELL";

    confidence =
      clamp(confidence * 0.7,0.25,0.55);

    riskPct =
      clamp(riskPct * 0.5,MIN_RISK,MAX_RISK);

  }

  /* ================= RISK SCALING ================= */

  if(confidence > 0.82)
    riskPct *= 1.7;
  else if(confidence > 0.68)
    riskPct *= 1.25;
  else if(confidence < 0.45)
    riskPct *= 0.5;

  riskPct =
    clamp(riskPct,MIN_RISK,MAX_RISK);

  if(action === "BUY" || action === "SELL")
    brain.lastTradeTime = now;

  brain.lastAction = action;
  brain.lastDecisionTime = now;

  return{
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    ts:now
  };

}

/* ================= RECORD TRADE RESULT ================= */

function recordTradeOutcome({
  tenantId,
  pnl
}){

  const brain =
    getBrainState(tenantId);

  if(pnl > 0)
    brain.lossStreak = 0;
  else
    brain.lossStreak++;

}

function resetTenant(tenantId){
  BRAIN_STATE.delete(tenantId);
}

module.exports = {
  makeDecision,
  resetTenant,
  recordTradeOutcome
};
