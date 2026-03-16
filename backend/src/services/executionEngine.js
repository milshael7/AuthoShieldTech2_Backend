// ==========================================================
// FILE: backend/src/services/executionEngine.js
// MODULE: Execution Engine
// VERSION: v18 (Institutional Scaling Execution Engine)
// ==========================================================

const outsideBrain =
  require("../../brain/aiBrain");

const axios = require("axios");

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

const MAX_EQUITY_EXPOSURE = 0.05;
const HARD_ACCOUNT_RISK   = 0.02;

const MAX_TRADE_USD       = 2000;
const MIN_TRADE_USD       = 25;

/* ================= LIVE SAFETY ================= */

const LIVE_TRADING_ENABLED =
  process.env.LIVE_TRADING_ENABLED === "true";

const LIVE_MIN_TRADE_INTERVAL = 10000;

const MAX_LIVE_QTY = 100;

let LAST_LIVE_TRADE = 0;

/* ================= MICRO LOCK ================= */

let LAST_EXECUTION_TIME = 0;
const EXECUTION_COOLDOWN = 500;

/* =========================================================
POSITION SIZE
========================================================= */

function calculatePositionSize(state,price,riskPct){

  const equity =
    safeNum(state.equity,
      safeNum(state.cashBalance,0)
    );

  if(equity <= 0 || price <= 0)
    return 0;

  const riskCapital =
    equity * safeNum(riskPct,0.01);

  const exposureCap =
    equity * MAX_EQUITY_EXPOSURE;

  const accountRiskLimit =
    equity * HARD_ACCOUNT_RISK;

  const allowedCapital =
    Math.min(
      riskCapital,
      exposureCap,
      accountRiskLimit,
      MAX_TRADE_USD
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
    state.availableCapital = state.cashBalance;

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
    peakProfit:0
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

  const capitalReleased =
    (pos.capitalUsed * closePct) + pnl;

  state.lockedCapital -=
    pos.capitalUsed * closePct;

  state.availableCapital +=
    capitalReleased;

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

  state.cashBalance =
    state.availableCapital;

  const trade = {
    side:"CLOSE",
    symbol:pos.symbol,
    entry:pos.entry,
    price,
    qty:pos.qty,
    pnl,
    duration: ts - pos.time,
    peakProfit:pos.peakProfit || 0,
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

    console.error(
      "AI learning error:",
      err.message
    );

  }

  return { result: trade };

}

/* =========================================================
PAPER EXECUTION
========================================================= */

function executePaperOrder({

  tenantId,
  symbol,
  action,
  price,
  riskPct,
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

  if(positionSize <= 0)
    return null;

  /* BUY */

  if(action === "BUY"){

    if(pos) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"LONG",
      ts
    });

  }

  /* SELL */

  if(action === "SELL"){

    if(pos) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"SHORT",
      ts
    });

  }

  /* PARTIAL CLOSE */

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

  /* CLOSE */

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
