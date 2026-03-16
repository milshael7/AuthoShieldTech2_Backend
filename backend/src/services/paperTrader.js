// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: v30 (Institutional Short-Duration Engine)
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

const MAX_DECISIONS_MEMORY = 200;

/* --- TRADE CONTROL --- */

const COOLDOWN_AFTER_TRADE = 120000;
const MAX_TRADES_PER_DAY = 40;
const MAX_DAILY_LOSSES = 12;

/* --- SHORT DURATION --- */

const MIN_TRADE_DURATION = 5 * 60 * 1000;
const MAX_TRADE_DURATION = 8 * 60 * 1000;

/* ========================================================= */

const STATE_FILE =
  path.join(process.cwd(),"paperTrader_state.json");

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

/* =========================================================
LOAD STATE
========================================================= */

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
CONFIG
========================================================= */

function getTradingConfig(tenantId){

  try{

    const db = readDb();

    const cfg =
      db.tradingConfig?.[tenantId] ||
      db.tradingConfig ||
      {};

    return {

      enabled: cfg.enabled ?? true,
      tradingMode: cfg.tradingMode || "paper",

      riskPercent:
        Number(cfg.riskPercent || 1)

    };

  }catch{

    return {

      enabled:true,
      tradingMode:"paper",
      riskPercent:1

    };

  }

}

/* =========================================================
VOLATILITY TARGET
========================================================= */

function computeTargets(volatility){

  const base = volatility || 0.002;

  const profitTarget =
    Math.max(0.0015, base * 1.2);

  const stopLoss =
    -Math.max(0.001, base * 0.8);

  return{
    profitTarget,
    stopLoss
  };

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

  if(pnl > 0){
    state.realized.wins++;
  }
  else{
    state.realized.losses++;
    state.limits.lossesToday++;
  }

  state.lastTradeTime = ts;

  saveState(state);

  return true;

}

/* =========================================================
ACTIVE POSITION
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

  const targets =
    computeTargets(state.volatility);

  if(pnl >= targets.profitTarget)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(pnl <= targets.stopLoss)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(elapsed >= pos.maxDuration)
    return closeTrade({tenantId,state,symbol,price,ts});

  return false;

}

/* =========================================================
AI TICK
========================================================= */

function tick(tenantId,symbol,price,ts=Date.now()){

  const state = load(tenantId);
  const cfg = getTradingConfig(tenantId);

  if(!state.running) return;
  if(!cfg.enabled) return;

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

    try{

      memoryBrain.recordMarketState({
        tenantId,
        symbol,
        price,
        volatility:state.volatility
      });

    }catch{}

    /* ACTIVE TRADE */

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

    const sinceLastTrade =
      ts - state.lastTradeTime;

    if(sinceLastTrade < COOLDOWN_AFTER_TRADE)
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
        riskPct:cfg.riskPercent / 100,
        state,
        ts

      });

    if(exec?.result){

      state.executionStats.trades++;
      state.limits.tradesToday++;

      if(state.position){

        state.position.maxDuration =
          computeDuration(plan.confidence);

      }

      saveState(state);

    }

  }
  finally{

    state._locked = false;

  }

}

/* =========================================================
SNAPSHOT
========================================================= */

function snapshot(tenantId){

  const s = load(tenantId);

  return {

    uptime:
      Date.now() - ENGINE_START,

    cashBalance:s.cashBalance,
    availableCapital:s.availableCapital,
    lockedCapital:s.lockedCapital,

    equity:s.equity,
    peakEquity:s.peakEquity,

    position:s.position || null,

    trades:s.trades || [],
    decisions:s.decisions || [],

    lastPrice:s.lastPrice,
    volatility:s.volatility,

    executionStats:s.executionStats,
    realized:s.realized,
    limits:s.limits

  };

}

module.exports = {

  tick,
  snapshot,

  getDecisions:
    tenantId =>
      load(tenantId)
        .decisions.slice(-50),

  hardReset:
    tenantId =>
      STATES.set(
        tenantId,
        defaultState()
      )

};
