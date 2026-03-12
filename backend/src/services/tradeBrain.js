// -----------------------------------------------------------
// AutoShield — Institutional Trade Brain (Adaptive Balanced v7)
// STABLE ENGINE VERSION — Memory Safe
// -----------------------------------------------------------

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.82);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.88);

const MIN_CONFIDENCE_TO_TRADE =
  Number(process.env.TRADE_MIN_CONFIDENCE || 0.55);

const MAX_RISK = 0.06;
const MIN_RISK = 0.001;

const ACTIONS = new Set(["WAIT","BUY","SELL","CLOSE"]);

/* ================= MEMORY ================= */

const BRAIN_STATE = new Map();

/* Prevent runaway tenant memory */
const MAX_BRAIN_TENANTS = 500;
const IDLE_RESET_MS = 1000 * 60 * 60 * 12; // 12h

function getBrainState(tenantId){

  const key = tenantId || "__default__";

  if(!BRAIN_STATE.has(key)){

    if(BRAIN_STATE.size > MAX_BRAIN_TENANTS){
      BRAIN_STATE.clear();
    }

    BRAIN_STATE.set(key,{
      smoothedConfidence:0.25,
      edgeMomentum:0,
      lastAction:"WAIT",
      lastDecisionTime:0
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

/* ================= DECISION ================= */

function makeDecision(context={}){

  const {
    tenantId,
    symbol="BTCUSDT",
    last,
    paper={},
    ticksSeen = 0
  } = context;

  const brain = getBrainState(tenantId);

  const price = safeNum(last,NaN);

  const limits = paper.limits || {};
  const pos = paper.position || null;

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
      ticksSeen,
      limits,
      paperState:paper
    }) || {};

  }catch{}

  let action = strategy.action || "WAIT";
  let confidence = safeNum(strategy.confidence,0.25);
  let edge = safeNum(strategy.edge,0);

  if(!ACTIONS.has(action))
    action="WAIT";

  /* ================= POSITION RULES ================= */

  if(!pos && action==="CLOSE")
    action="WAIT";

  if(pos){

    if(pos.side==="LONG" && action==="BUY")
      action="WAIT";

    if(pos.side==="SHORT" && action==="SELL")
      action="WAIT";

  }

  if(!pos && action==="SELL" && !isPaper)
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
      clamp((confidence*0.65)+(aiConf*0.35),0,1);

    edge =
      clamp((edge*0.65)+(aiEdge*0.35),-1,1);

  }catch{}

  /* ================= CONFIDENCE SMOOTHING ================= */

  const decay =
    isPaper ? 0.25 : CONFIDENCE_DECAY;

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
    isPaper ? 0.10 : MIN_CONFIDENCE_TO_TRADE;

  if(confidence < dynamicThreshold)
    action="WAIT";

  /* ================= HARD SAFETY ================= */

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

  riskPct =
    clamp(riskPct,MIN_RISK,MAX_RISK);

  /* ================= WAIT HANDLING ================= */

  if(action==="WAIT"){
    edge = edge * 0.5;
  }

  brain.lastAction = action;
  brain.lastDecisionTime = Date.now();

  return{
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    ts:Date.now()
  };

}

/* ================= RESET ================= */

function resetTenant(tenantId){
  BRAIN_STATE.delete(tenantId);
}

module.exports = {
  makeDecision,
  resetTenant
};
