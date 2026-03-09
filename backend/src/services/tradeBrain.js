// -----------------------------------------------------------
// AutoShield — Institutional Trade Brain (Adaptive Balanced)
// Active Paper Mode • Strict Live Mode
// -----------------------------------------------------------

const aiBrain = require("./aiBrain");
const memoryBrain = require("./memoryBrain");
const { buildDecision } = require("./strategyEngine");
const capitalProtection = require("./capitalProtection");
const orderFlowEngine = require("./orderFlowEngine");
const liquidityEngine = require("./liquidityEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.82);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.88);

const VOL_HIGH =
  Number(process.env.TRADE_VOL_HIGH || 0.02);

const MIN_CONFIDENCE_TO_TRADE =
  Number(process.env.TRADE_MIN_CONFIDENCE || 0.55);

const STRONG_CONFIDENCE =
  Number(process.env.TRADE_STRONG_CONFIDENCE || 0.82);

const MAX_RISK = 0.06;
const MIN_RISK = 0.001;

const ACTIONS = new Set(["WAIT","BUY","SELL","CLOSE"]);

/* ================= MEMORY ================= */

const BRAIN_STATE = new Map();

function getBrainState(tenantId){

  const key = tenantId || "__default__";

  if(!BRAIN_STATE.has(key)){

    BRAIN_STATE.set(key,{
      smoothedConfidence:0,
      edgeMomentum:0,
      lastAction:"WAIT",
      lastDecisionTime:0,
      winStreak:0,
      lossStreak:0,
      lastRealizedNet:0,
      aggressionFactor:1
    });

  }

  return BRAIN_STATE.get(key);

}

/* ================= UTILS ================= */

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

/* ================= PERFORMANCE ================= */

function updatePerformance(brain,paper){

  const realizedNet =
    safeNum(paper?.realized?.net,0);

  const delta =
    realizedNet - brain.lastRealizedNet;

  if(delta > 0){
    brain.winStreak++;
    brain.lossStreak = 0;
  }
  else if(delta < 0){
    brain.lossStreak++;
    brain.winStreak = 0;
  }

  brain.lastRealizedNet = realizedNet;

  if(brain.winStreak >= 2)
    brain.aggressionFactor =
      clamp(brain.aggressionFactor + 0.1,1,1.8);

  if(brain.lossStreak >= 2)
    brain.aggressionFactor =
      clamp(brain.aggressionFactor * 0.8,0.6,1);

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

  updatePerformance(brain,paper);

  const price = safeNum(last,NaN);

  const limits = paper.limits || {};
  const learn = paper.learnStats || {};

  const hasPosition = !!paper.position;

  const tradesToday = safeNum(limits.tradesToday,0);
  const lossesToday = safeNum(limits.lossesToday,0);
  const volatility = safeNum(paper.volatility,0);

  const isPaper =
    paper?.cashBalance !== undefined &&
    paper?.equity !== undefined;

  /* ================= STRATEGY ================= */

  let strategy = {};

  try{
    strategy = buildDecision({
      tenantId,
      symbol,
      price,
      lastPrice:paper.lastPrice,
      volatility,
      ticksSeen:learn.ticksSeen,
      limits,
      paperState:paper
    }) || {};
  }catch{}

  let action = strategy.action || "WAIT";
  let confidence = safeNum(strategy.confidence,0);
  let edge = safeNum(strategy.edge,0);
  let reason = strategy.reason || "strategy";

  if(!ACTIONS.has(action))
    action="WAIT";

  /* ================= POSITION NORMALIZATION ================= */

  if(!hasPosition && action==="SELL")
    action="WAIT";

  if(hasPosition && action==="BUY")
    action="WAIT";

  /* ================= AI OVERLAY ================= */

  try{

    const ai = aiBrain.decide({
      tenantId,
      symbol,
      last,
      paper
    }) || {};

    const aiConf = safeNum(ai.confidence,0);
    const aiEdge = safeNum(ai.edge,0);

    confidence =
      clamp((confidence*0.6)+(aiConf*0.4),0,1);

    edge =
      clamp((edge*0.6)+(aiEdge*0.4),-1,1);

  }catch{}

  /* ================= ORDER FLOW (Paper Relaxed) ================= */

  try{

    const flow =
      orderFlowEngine.analyzeFlow({tenantId});

    confidence *= flow.boost || 1;

    if(!isPaper &&
      (flow.type==="fake_breakout" ||
       flow.type==="trend_exhaustion")){
      action="WAIT";
      reason="Order flow risk";
    }

  }catch{}

  /* ================= LIQUIDITY (Paper Relaxed) ================= */

  try{

    const liquidity =
      liquidityEngine.analyzeLiquidity({tenantId});

    confidence *= liquidity.boost || 1;

    if(!isPaper &&
      (liquidity.type==="bull_trap" ||
       liquidity.type==="bear_trap")){
      action="WAIT";
      reason="Liquidity trap";
    }

  }catch{}

  /* ================= CONFIDENCE SMOOTHING ================= */

  const decay =
    isPaper ? 0.6 : CONFIDENCE_DECAY;

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

  /* ================= CONFIDENCE GATE ================= */

  const dynamicThreshold =
    isPaper ? 0.35 : MIN_CONFIDENCE_TO_TRADE;

  if(confidence < dynamicThreshold){
    action="WAIT";
    reason="Confidence below threshold";
  }

  /* ================= HARD SAFETY (Live Only Strict) ================= */

  if(!isPaper){

    if(!Number.isFinite(price))
      action="WAIT";

    if(limits.halted)
      action="WAIT";

    if(tradesToday >= MAX_TRADES_PER_DAY)
      action="WAIT";

    if(lossesToday >= MAX_LOSS_STREAK)
      action="WAIT";
  }

  /* ================= RISK ================= */

  let riskPct =
    safeNum(strategy.riskPct,0.01);

  riskPct *= brain.aggressionFactor;

  if(confidence < 0.6)
    riskPct *= 0.6;

  if(confidence > STRONG_CONFIDENCE)
    riskPct *= isPaper ? 1.5 : 1.25;

  riskPct =
    clamp(riskPct,MIN_RISK,MAX_RISK);

  /* ================= CAPITAL PROTECTION ================= */

  try{

    const balanceUsd =
      paper?.equity ||
      paper?.cashBalance ||
      0;

    const protection =
      capitalProtection.validateOrder({
        balanceUsd,
        price,
        riskPct
      });

    if(!protection.allow){
      action="WAIT";
      confidence=0;
      edge=0;
      reason=protection.reason;
    }
    else{
      riskPct =
        protection.usd / balanceUsd;
    }

  }catch{}

  if(action==="WAIT"){
    confidence=0;
    edge=0;
  }

  brain.lastAction = action;
  brain.lastDecisionTime = Date.now();

  try{

    memoryBrain.recordSignal({
      tenantId,
      symbol,
      action,
      confidence,
      edge,
      price,
      volatility
    });

    memoryBrain.recordMarketState({
      tenantId,
      symbol,
      price,
      volatility
    });

  }catch{}

  return{
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    reason,
    behavioral:{
      winStreak:brain.winStreak,
      lossStreak:brain.lossStreak,
      aggressionFactor:brain.aggressionFactor,
      mode:isPaper
        ? "paper-learning"
        : "live-capital"
    },
    learning:strategy.learning,
    ts:Date.now()
  };

}

function resetTenant(tenantId){
  BRAIN_STATE.delete(tenantId);
}

module.exports = {
  makeDecision,
  resetTenant
};
