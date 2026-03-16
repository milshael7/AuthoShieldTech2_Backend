// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: AI GOVERNED STABLE v24
//
// FIXES
// ----------------------------------------------------------
// ✔ Persistent engine state (prevents memory reset)
// ✔ Removed duplicate trade logging
// ✔ Crash recovery support
// ✔ Stable AI loop
// ==========================================================

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const memoryBrain = require("../../brainMemory/memoryBrain");
const { readDb } = require("../lib/db");

const ENGINE_START = Date.now();

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const MAX_DECISIONS_MEMORY = 200;

const MIN_TRADE_INTERVAL = 30000;

const STATE_FILE =
  path.join(process.cwd(),"paperTrader_state.json");

/* ================= STATE ================= */

function defaultState(){
  return{
    running:true,
    cashBalance:START_BAL,
    equity:START_BAL,
    peakEquity:START_BAL,
    position:null,
    trades:[],
    decisions:[],
    volatility:0.003,
    lastPrice:60000,
    lastTradeTime:0,

    realized:{wins:0,losses:0,net:0},
    limits:{tradesToday:0,lossesToday:0},

    executionStats:{
      ticks:0,
      decisions:0,
      trades:0
    },

    _locked:false
  };
}

const STATES = new Map();

/* ================= STATE PERSISTENCE ================= */

function saveState(tenantId,state){

  try{

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(state,null,2)
    );

  }catch(err){

    console.error(
      "State save failed:",
      err.message
    );

  }

}

function loadStateFromDisk(){

  try{

    if(fs.existsSync(STATE_FILE)){

      const raw =
        JSON.parse(
          fs.readFileSync(STATE_FILE,"utf-8")
        );

      return raw;

    }

  }catch(err){

    console.error(
      "State load failed:",
      err.message
    );

  }

  return null;

}

/* ================= LOAD ================= */

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

/* ================= CONFIG ================= */

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
      riskPercent: Number(cfg.riskPercent || 1.5),
      positionMultiplier: Number(cfg.positionMultiplier || 1)
    };

  }catch{

    return {
      enabled:true,
      tradingMode:"paper",
      riskPercent:1.5,
      positionMultiplier:1
    };

  }

}

/* ================= AI TICK ================= */

function tick(tenantId,symbol,price,ts=Date.now()){

  const state = load(tenantId);
  const cfg = getTradingConfig(tenantId);

  if(!state.running) return;
  if(!cfg.enabled) return;
  if(!Number.isFinite(price) || price<=0) return;
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

    const sinceLastTrade =
      ts - state.lastTradeTime;

    const allowTrade =
      sinceLastTrade >= MIN_TRADE_INTERVAL;

    const plan =
      makeDecision({
        tenantId,
        symbol,
        last: price,
        paper: state,
        ticksSeen: state.executionStats.ticks
      }) || {
        action:"WAIT",
        confidence:0,
        riskPct:0
      };

    plan.riskPct =
      (Number(cfg.riskPercent)/100) *
      Number(cfg.positionMultiplier);

    state.executionStats.decisions++;

    if(["BUY","SELL","CLOSE"].includes(plan.action) && allowTrade){

      const exec =
        executionEngine.executePaperOrder({
          tenantId,
          symbol,
          action:plan.action,
          price,
          riskPct:plan.riskPct,
          state,
          ts
        });

      if(exec?.result){

        state.executionStats.trades++;
        state.lastTradeTime = ts;

      }

    }

    if(state.position){

      const unrealized =
        state.position.side === "LONG"
          ? (price - state.position.entry) * state.position.qty
          : (state.position.entry - price) * state.position.qty;

      state.equity =
        state.cashBalance + unrealized;

    }else{

      state.equity =
        state.cashBalance;

    }

    if(state.equity > state.peakEquity)
      state.peakEquity = state.equity;

    saveState(tenantId,state);

  }
  finally{

    state._locked = false;

  }

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId){

  const s = load(tenantId);

  return {

    uptime:
      Date.now() - ENGINE_START,

    cashBalance:Number(s.cashBalance||0),
    equity:Number(s.equity||0),
    peakEquity:Number(s.peakEquity||0),

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
