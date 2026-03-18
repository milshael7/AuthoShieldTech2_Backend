// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v23 (Adaptive Size + True Confidence Scaling)
// ==========================================================

const outsideBrain =
  require("../../brain/aiBrain");

/* ================= UTIL ================= */

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureTradeLog(state){
  if(!Array.isArray(state.trades)){
    state.trades = [];
  }
}

/* =========================================================
RISK CONFIGURATION
========================================================= */

const MAX_EQUITY_EXPOSURE = 0.10;
const HARD_ACCOUNT_RISK   = 0.02;

const MAX_TRADE_USD       = 15000;
const MIN_TRADE_USD       = 100;

const MAX_PYRAMIDS        = 3;

/* ================= MICRO LOCK ================= */

let LAST_EXECUTION_TIME = 0;
const EXECUTION_COOLDOWN = 400;

/* =========================================================
POSITION SIZE
========================================================= */

function calculatePositionSize(state,price,riskPct){

  const equity =
    safeNum(
      state.equity,
      safeNum(state.cashBalance,0)
    );

  if(equity <= 0 || price <= 0)
    return 0;

  let riskCapital =
    equity * safeNum(riskPct,0.01);

  const confidence =
    safeNum(state?.lastConfidence,0.5);

  let confidenceBoost = 1;

  if(confidence >= 0.90) confidenceBoost = 2.25;
  else if(confidence >= 0.80) confidenceBoost = 1.85;
  else if(confidence >= 0.70) confidenceBoost = 1.45;
  else if(confidence >= 0.60) confidenceBoost = 1.15;
  else if(confidence < 0.40) confidenceBoost = 0.70;

  riskCapital *= confidenceBoost;

  const exposureCap =
    equity * MAX_EQUITY_EXPOSURE;

  const accountRiskLimit =
    equity * HARD_ACCOUNT_RISK;

  const allowedCapital =
    Math.min(
      riskCapital,
      exposureCap,
      accountRiskLimit,
      MAX_TRADE_USD,
      safeNum(state.availableCapital,equity)
    );

  if(allowedCapital < MIN_TRADE_USD)
    return 0;

  let qty =
    allowedCapital / price;

  qty = clamp(qty,0,1e9);

  return Number(qty.toFixed(6));
}

/* =========================================================
OPEN POSITION
========================================================= */

function openPosition({
  state,
  symbol,
  price,
  qty,
  side,
  ts
}){

  ensureTradeLog(state);

  const cost = qty * price;

  if(state.availableCapital === undefined)
    state.availableCapital = safeNum(state.cashBalance,0);

  if(state.lockedCapital === undefined)
    state.lockedCapital = 0;

  if(cost > state.availableCapital)
    return null;

  state.availableCapital -= cost;
  state.lockedCapital += cost;

  state.position = {
    symbol,
    side,
    entry:price,
    qty,
    capitalUsed:cost,
    time:ts,
    peakProfit:0,
    pyramidCount:0
  };

  const trade = {
    side,
    symbol,
    entry:price,
    price,
    qty,
    capitalUsed:cost,
    pnl:0,
    time:ts
  };

  state.trades.push(trade);

  return { result: trade };
}

/* =========================================================
PYRAMID FILTER
========================================================= */

function allowPyramid(pos,price){

  if(!pos) return false;

  if((pos.pyramidCount || 0) >= MAX_PYRAMIDS)
    return false;

  const pnl =
    pos.side === "LONG"
      ? (price-pos.entry)/pos.entry
      : (pos.entry-price)/pos.entry;

  return pnl > 0.003;
}

/* =========================================================
ADD TO POSITION
========================================================= */

function addToPosition({
  state,
  price,
  qty,
  ts
}){

  ensureTradeLog(state);

  const pos = state.position;

  if(!allowPyramid(pos,price))
    return null;

  const cost = qty * price;

  if(cost > state.availableCapital)
    return null;

  const newQty =
    pos.qty + qty;

  const newEntry =
    ((pos.entry * pos.qty) + (price * qty)) / newQty;

  pos.qty = newQty;
  pos.entry = newEntry;
  pos.capitalUsed += cost;

  state.availableCapital -= cost;
  state.lockedCapital += cost;

  pos.pyramidCount =
    (pos.pyramidCount || 0) + 1;

  const trade = {
    side:"ADD",
    symbol:pos.symbol,
    entry:newEntry,
    price,
    qty,
    time:ts
  };

  state.trades.push(trade);

  return { result: trade };
}

/* =========================================================
PARTIAL CLOSE
========================================================= */

function partialClosePosition({
  tenantId,
  state,
  price,
  closePct,
  ts
}){

  ensureTradeLog(state);

  const pos = state.position;

  if(!pos) return null;

  closePct = clamp(closePct,0.01,1);

  const qtyClose =
    pos.qty * closePct;

  const remainingQty =
    pos.qty - qtyClose;

  let pnl = 0;

  if(pos.side === "LONG")
    pnl = (price - pos.entry) * qtyClose;

  if(pos.side === "SHORT")
    pnl = (pos.entry - price) * qtyClose;

  const lockedRelease =
    pos.capitalUsed * closePct;

  const capitalReleased =
    lockedRelease + pnl;

  state.lockedCapital -= lockedRelease;
  state.availableCapital += capitalReleased;

  pos.qty = remainingQty;
  pos.capitalUsed =
    pos.capitalUsed * (1 - closePct);

  const trade = {
    side:"PARTIAL_CLOSE",
    symbol:pos.symbol,
    entry:pos.entry,
    price,
    qty:qtyClose,
    pnl,
    time:ts
  };

  state.trades.push(trade);

  if(pos.qty <= 0.000001){
    state.position = null;
    state.cashBalance = state.availableCapital;
  }

  return { result: trade };
}

/* =========================================================
FULL CLOSE
========================================================= */

function closePosition({
  tenantId,
  state,
  price,
  ts
}){

  ensureTradeLog(state);

  const pos = state.position;

  if(!pos) return null;

  let pnl = 0;

  if(pos.side === "LONG")
    pnl = (price - pos.entry) * pos.qty;

  if(pos.side === "SHORT")
    pnl = (pos.entry - price) * pos.qty;

  const capitalReturn =
    pos.capitalUsed + pnl;

  state.lockedCapital -= pos.capitalUsed;
  state.availableCapital += capitalReturn;
  state.cashBalance = state.availableCapital;

  const trade = {
    side:"CLOSE",
    symbol:pos.symbol,
    entry:pos.entry,
    price,
    qty:pos.qty,
    pnl,
    duration: ts - pos.time,
    pyramids:pos.pyramidCount || 0,
    time:ts
  };

  state.trades.push(trade);

  state.position = null;

  try{
    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl
    });
  }catch(err){
    console.error("AI learning error:", err.message);
  }

  return { result: trade };
}

/* =========================================================
EXECUTION
========================================================= */

function executePaperOrder({
  tenantId,
  symbol,
  action,
  price,
  riskPct,
  confidence,
  qty,
  closePct,
  state,
  ts = Date.now()
}){

  if(!state) return null;
  if(!symbol) return null;

  price = safeNum(price,0);

  if(price <= 0)
    return null;

  const now = Date.now();

  if(now - LAST_EXECUTION_TIME < EXECUTION_COOLDOWN)
    return null;

  LAST_EXECUTION_TIME = now;

  const pos = state.position;

  state.lastConfidence =
    clamp(
      safeNum(confidence, state.lastConfidence || 0.5),
      0,
      1
    );

  let positionSize =
    safeNum(qty,0);

  if(positionSize <= 0){
    positionSize =
      calculatePositionSize(
        state,
        price,
        riskPct || 0.01
      );
  }

  if(action === "BUY"){
    if(pos) return null;
    if(positionSize <= 0) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"LONG",
      ts
    });
  }

  if(action === "SELL"){
    if(pos) return null;
    if(positionSize <= 0) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"SHORT",
      ts
    });
  }

  if(action === "ADD"){
    if(!pos) return null;
    if(positionSize <= 0) return null;

    return addToPosition({
      state,
      price,
      qty:positionSize * 0.5,
      ts
    });
  }

  if(action === "PARTIAL_CLOSE"){
    if(!pos) return null;

    return partialClosePosition({
      tenantId,
      state,
      price,
      closePct: safeNum(closePct,0.25),
      ts
    });
  }

  if(action === "CLOSE"){
    if(!pos) return null;

    return closePosition({
      tenantId,
      state,
      price,
      ts
    });
  }

  return null;
}

module.exports = {
  executePaperOrder
};
