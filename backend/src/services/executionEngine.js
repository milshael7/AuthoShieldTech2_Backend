// ==========================================================
// FILE: backend/src/services/executionEngine.js
// MODULE: Execution Engine
// VERSION: v13 (Institutional Live Safety Layer)
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

const LIVE_MIN_TRADE_INTERVAL = 10000; // 10 seconds
let LAST_LIVE_TRADE = 0;

/* =========================================================
POSITION SIZE CALCULATION
========================================================= */

function calculatePositionSize(state,price,riskPct){

  const equity =
    safeNum(state.equity,safeNum(state.cashBalance,0));

  if(equity <= 0 || price <= 0)
    return 0;

  const riskCapital =
    equity * riskPct;

  const equityExposureCap =
    equity * MAX_EQUITY_EXPOSURE;

  const hardAccountLimit =
    equity * HARD_ACCOUNT_RISK;

  const allowedCapital =
    Math.min(
      riskCapital,
      equityExposureCap,
      hardAccountLimit,
      MAX_TRADE_USD
    );

  if(allowedCapital < MIN_TRADE_USD)
    return 0;

  let qty =
    allowedCapital / price;

  qty = Number(qty.toFixed(6));

  return qty;

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
    time:ts
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
CLOSE POSITION
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

  if(pos.side === "LONG"){
    pnl = (price - pos.entry) * pos.qty;
  }

  if(pos.side === "SHORT"){
    pnl = (pos.entry - price) * pos.qty;
  }

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
  state,
  ts = Date.now()

}){

  if(!state) return null;
  if(!symbol) return null;
  if(!Number.isFinite(price)) return null;

  if(state.cashBalance <= 0)
    return null;

  riskPct =
    clamp(
      safeNum(riskPct,0.01),
      0.001,
      0.05
    );

  const pos = state.position;

  let positionSize =
    safeNum(qty,0);

  if(positionSize <= 0){

    positionSize =
      calculatePositionSize(
        state,
        price,
        riskPct
      );

  }

  if(positionSize <= 0)
    return null;

  if(action === "BUY"){

    if(pos){

      if(pos.side === "LONG")
        return null;

      if(pos.side === "SHORT"){

        closePosition({
          tenantId,
          state,
          price,
          ts
        });

        return openPosition({
          state,
          symbol,
          price,
          qty:positionSize,
          side:"LONG",
          ts
        });

      }

    }

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

    if(pos){

      if(pos.side === "SHORT")
        return null;

      if(pos.side === "LONG"){

        closePosition({
          tenantId,
          state,
          price,
          ts
        });

        return openPosition({
          state,
          symbol,
          price,
          qty:positionSize,
          side:"SHORT",
          ts
        });

      }

    }

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"SHORT",
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

/* =========================================================
LIVE EXECUTION
========================================================= */

async function executeLiveOrder({

  symbol,
  action,
  price,
  qty

}){

  try{

    const now = Date.now();

    if(now - LAST_LIVE_TRADE < LIVE_MIN_TRADE_INTERVAL){
      console.warn("Live trade blocked: too frequent");
      return null;
    }

    const apiKey =
      process.env.EXCHANGE_API_KEY;

    const secret =
      process.env.EXCHANGE_SECRET;

    if(!apiKey || !secret){

      console.warn(
        "Live trading keys missing"
      );

      return null;

    }

    const quantity = safeNum(qty,0);

    if(quantity <= 0){
      console.warn("Invalid trade quantity");
      return null;
    }

    const tradeCapital = quantity * safeNum(price,0);

    if(tradeCapital > MAX_TRADE_USD){
      console.warn("Live trade exceeds capital limit");
      return null;
    }

    const side =
      action === "BUY"
        ? "BUY"
        : "SELL";

    const response =
      await axios.post(
        process.env.EXCHANGE_ORDER_ENDPOINT,
        {
          symbol,
          side,
          type:"MARKET",
          quantity
        },
        {
          headers:{
            "X-API-KEY":apiKey
          }
        }
      );

    if(!response?.data?.orderId){
      console.warn("Exchange rejected order");
      return null;
    }

    LAST_LIVE_TRADE = now;

    return {
      result:{
        side,
        price,
        qty:quantity,
        live:true,
        exchangeId:
          response.data.orderId
      }
    };

  }catch(err){

    console.error(
      "Live execution failed:",
      err.message
    );

    return null;

  }

}

module.exports = {
  executePaperOrder,
  executeLiveOrder
};
