// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: v35 (Institutional Entry + Exit Engine)
// ==========================================================

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

const ENGINE_START = Date.now();

/* =========================================================
CONFIG
========================================================= */

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const COOLDOWN_AFTER_TRADE = 120000;
const MAX_TRADES_PER_DAY = 40;
const MAX_DAILY_LOSSES = 12;

const MIN_TRADE_DURATION = 10 * 60 * 1000;
const MAX_TRADE_DURATION = 15 * 60 * 1000;

const HARD_STOP_LOSS = -0.0025;
const PROFIT_PROTECTION = 0.35;

const STATE_FILE =
  path.join(process.cwd(),"paperTrader_state.json");

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_HISTORY = new Map();

function recordPrice(tenantId,price){

  const key = tenantId || "__default__";

  if(!PRICE_HISTORY.has(key))
    PRICE_HISTORY.set(key,[]);

  const arr = PRICE_HISTORY.get(key);

  arr.push(price);

  if(arr.length > 14)
    arr.shift();

  return arr;

}

/* =========================================================
REVERSAL DETECTION
========================================================= */

function detectReversal(prices){

  if(prices.length < 6) return false;

  const a = prices[prices.length-6];
  const b = prices[prices.length-5];
  const c = prices[prices.length-4];
  const d = prices[prices.length-3];
  const e = prices[prices.length-2];
  const f = prices[prices.length-1];

  if(a < b && b < c && c < d && e < d && f < e)
    return true;

  if(a > b && b > c && c > d && e > d && f > e)
    return true;

  return false;

}

/* =========================================================
MOMENTUM WEAKENING
========================================================= */

function detectMomentumWeakening(prices){

  if(prices.length < 6) return false;

  const m1 = prices[prices.length-1] - prices[prices.length-2];
  const m2 = prices[prices.length-2] - prices[prices.length-3];
  const m3 = prices[prices.length-3] - prices[prices.length-4];

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);

}

/* =========================================================
STALL DETECTION
========================================================= */

function detectStall(prices){

  if(prices.length < 5) return false;

  const r1 =
    Math.abs(prices[prices.length-1] - prices[prices.length-2]);

  const r2 =
    Math.abs(prices[prices.length-2] - prices[prices.length-3]);

  const r3 =
    Math.abs(prices[prices.length-3] - prices[prices.length-4]);

  return r1 < r2 && r2 < r3;

}

/* =========================================================
STATE
========================================================= */

function defaultState(){

  return{

    running:true,

    cashBalance:START_BAL,
    availableCapital:START_BAL,
    lockedCapital:0,

    position:null,

    trades:[],

    volatility:0.003,
    lastPrice:60000,
    lastTradeTime:0,

    limits:{
      tradesToday:0,
      lossesToday:0
    },

    executionStats:{
      ticks:0,
      decisions:0,
      trades:0
    },

    _locked:false
  };

}

const STATES = new Map();

/* =========================================================
STATE LOAD
========================================================= */

function load(tenantId){

  if(STATES.has(tenantId))
    return STATES.get(tenantId);

  const state = defaultState();

  STATES.set(tenantId,state);

  return state;

}

/* =========================================================
CLOSE TRADE
========================================================= */

function closeTrade({
  tenantId,
  state,
  symbol,
  price,
  ts
}){

  const closed =
    executionEngine.executePaperOrder({

      tenantId,
      symbol,
      action:"CLOSE",
      price,
      state,
      ts

    });

  if(!closed?.result) return false;

  const pnl = closed.result.pnl || 0;

  if(pnl < 0)
    state.limits.lossesToday++;

  state.lastTradeTime = ts;

  return true;

}

/* =========================================================
POSITION MANAGEMENT
========================================================= */

function handleOpenPosition({
  tenantId,
  state,
  symbol,
  price,
  ts
}){

  const pos = state.position;
  if(!pos) return false;

  const elapsed = ts - pos.time;

  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry
      : (pos.entry - price) / pos.entry;

  const unrealized =
    pos.side === "LONG"
      ? (price - pos.entry) * pos.qty
      : (pos.entry - price) * pos.qty;

  pos.peakProfit =
    Math.max(pos.peakProfit || 0, unrealized);

  const prices =
    recordPrice(tenantId,price);

  if(detectReversal(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(detectMomentumWeakening(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(detectStall(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(pos.peakProfit > 0){

    const drawdown =
      pos.peakProfit - unrealized;

    const allowed =
      pos.peakProfit * PROFIT_PROTECTION;

    if(drawdown > allowed)
      return closeTrade({tenantId,state,symbol,price,ts});

  }

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(elapsed >= MAX_TRADE_DURATION)
    return closeTrade({tenantId,state,symbol,price,ts});

  return false;

}

/* =========================================================
TICK
========================================================= */

function tick(tenantId,symbol,price,ts=Date.now()){

  const state = load(tenantId);

  if(!state.running) return;

  if(!Number.isFinite(price) || price<=0)
    return;

  if(state._locked) return;

  state._locked = true;

  try{

    const prev = state.lastPrice;
    state.lastPrice = price;

    if(prev){

      const change =
        Math.abs(price-prev)/prev;

      state.volatility =
        Math.max(
          0.0005,
          state.volatility*0.9 +
          change*0.1
        );

    }

    state.executionStats.ticks++;

    /* HANDLE OPEN POSITION */

    if(state.position){

      handleOpenPosition({
        tenantId,
        state,
        symbol,
        price,
        ts
      });

      return;

    }

    /* COOLDOWN */

    if(ts - state.lastTradeTime < COOLDOWN_AFTER_TRADE)
      return;

    if(
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    )
      return;

    /* AI DECISION */

    const plan =
      makeDecision({

        tenantId,
        symbol,
        last:price,
        paper:state,
        ticksSeen:state.executionStats.ticks

      }) || {action:"WAIT"};

    state.executionStats.decisions++;

    if(!["BUY","SELL"].includes(plan.action))
      return;

    const exec =
      executionEngine.executePaperOrder({

        tenantId,
        symbol,
        action:plan.action,
        price,
        riskPct:0.01,
        state,
        ts

      });

    if(exec?.result){

      state.executionStats.trades++;
      state.limits.tradesToday++;

      if(state.position){

        state.position.maxDuration =
          MIN_TRADE_DURATION;

      }

    }

  }
  finally{

    state._locked = false;

  }

}

module.exports = {
  tick
};
