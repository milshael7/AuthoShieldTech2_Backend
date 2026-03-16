// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: v34 (Institutional Exit Intelligence Engine)
// ==========================================================

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const memoryBrain = require("../../brainMemory/memoryBrain");
const { readDb } = require("../lib/db");

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

  const range1 =
    Math.abs(prices[prices.length-1] - prices[prices.length-2]);

  const range2 =
    Math.abs(prices[prices.length-2] - prices[prices.length-3]);

  const range3 =
    Math.abs(prices[prices.length-3] - prices[prices.length-4]);

  return range1 < range2 && range2 < range3;

}

/* =========================================================
STATE
========================================================= */

function defaultState(){

  const startingCapital = START_BAL;

  return{

    running:true,

    cashBalance:startingCapital,
    availableCapital:startingCapital,
    lockedCapital:0,

    equity:startingCapital,
    peakEquity:startingCapital,

    position:null,

    trades:[],
    decisions:[],

    volatility:0.003,
    lastPrice:60000,
    lastTradeTime:0,

    realized:{
      wins:0,
      losses:0,
      net:0
    },

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
STATE STORAGE
========================================================= */

function saveState(state){

  try{

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(state,null,2)
    );

  }catch(err){

    console.error("State save failed:",err.message);

  }

}

function loadStateFromDisk(){

  try{

    if(!fs.existsSync(STATE_FILE))
      return null;

    return JSON.parse(
      fs.readFileSync(STATE_FILE,"utf-8")
    );

  }catch(err){

    console.error("State load failed:",err.message);
    return null;

  }

}

function load(tenantId){

  if(STATES.has(tenantId))
    return STATES.get(tenantId);

  const diskState =
    loadStateFromDisk();

  const state =
    diskState || defaultState();

  STATES.set(tenantId,state);

  return state;

}

/* =========================================================
TRADE DURATION
========================================================= */

function computeDuration(confidence){

  const ratio =
    Math.min(Math.max(confidence || 0,0),1);

  return Math.floor(
    MIN_TRADE_DURATION +
    ratio*(MAX_TRADE_DURATION-MIN_TRADE_DURATION)
  );

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

  state.realized.net += pnl;

  if(pnl > 0)
    state.realized.wins++;
  else{
    state.realized.losses++;
    state.limits.lossesToday++;
  }

  state.lastTradeTime = ts;

  saveState(state);

  return true;

}

/* =========================================================
ACTIVE POSITION MANAGEMENT
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

  /* REVERSAL */

  if(detectReversal(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* MOMENTUM WEAKENING */

  if(detectMomentumWeakening(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* STALL DETECTION */

  if(detectStall(prices) && pnl > 0)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* PROFIT PROTECTION */

  if(pos.peakProfit > 0){

    const drawdown =
      pos.peakProfit - unrealized;

    const allowed =
      pos.peakProfit * PROFIT_PROTECTION;

    if(drawdown > allowed)
      return closeTrade({tenantId,state,symbol,price,ts});

  }

  /* HARD STOP */

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* TIME EXIT */

  if(elapsed >= pos.maxDuration){

    const move =
      prices[prices.length-1] -
      prices[prices.length-3];

    const momentumStillStrong =
      pos.side === "LONG"
        ? move > 0
        : move < 0;

    if(!momentumStillStrong)
      return closeTrade({tenantId,state,symbol,price,ts});

  }

  return false;

}

/* =========================================================
AI TICK
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

  }
  finally{

    state._locked = false;

  }

}

module.exports = {
  tick
};
