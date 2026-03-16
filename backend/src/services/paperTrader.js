// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: v28 (Institutional Short-Duration Engine)
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

const MIN_TRADE_INTERVAL = 30000;

const MAX_TRADES_PER_DAY = 40;
const MAX_DAILY_LOSSES = 12;

/* ================= SHORT DURATION CONFIG ================= */

const MIN_TRADE_DURATION = 5 * 60 * 1000;
const MAX_TRADE_DURATION = 8 * 60 * 1000;

const PROFIT_TARGET = 0.0035;
const STOP_LOSS = -0.0025;

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
STATE PERSISTENCE
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

  if(state.availableCapital === undefined)
    state.availableCapital = state.cashBalance;

  if(state.lockedCapital === undefined)
    state.lockedCapital = 0;

  STATES.set(tenantId,state);

  return state;

}

/* =========================================================
CONFIG FETCH
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

/* =========================================================
DURATION ENGINE
========================================================= */

function computeDuration(confidence){

  if(!confidence)
    return MIN_TRADE_DURATION;

  const ratio =
    Math.min(Math.max(confidence,0),1);

  return Math.floor(
    MIN_TRADE_DURATION +
    ratio*(MAX_TRADE_DURATION-MIN_TRADE_DURATION)
  );

}

/* =========================================================
CLOSE TRADE HANDLER
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

  }else{

    state.realized.losses++;
    state.limits.lossesToday++;

  }

  return true;

}

/* =========================================================
ACTIVE TRADE MANAGEMENT
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

  /* PROFIT TARGET */

  if(pnl >= PROFIT_TARGET){

    return closeTrade({
      tenantId,state,symbol,price,ts
    });

  }

  /* STOP LOSS */

  if(pnl <= STOP_LOSS){

    return closeTrade({
      tenantId,state,symbol,price,ts
    });

  }

  /* MAX DURATION */

  if(elapsed >= (pos.maxDuration || MIN_TRADE_DURATION)){

    return closeTrade({
      tenantId,state,symbol,price,ts
    });

  }

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

  let stateChanged = false;

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

    /* HANDLE ACTIVE POSITION */

    if(state.position){

      const closed =
        handleOpenPosition({
          tenantId,
          state,
          symbol,
          price,
          ts
        });

      if(closed)
        stateChanged = true;

    }

    /* ================= DECISION ================= */

    const plan =
      makeDecision({

        tenantId,
        symbol,
        last:price,
        paper:state,
        ticksSeen:state.executionStats.ticks

      }) || {action:"WAIT"};

    state.executionStats.decisions++;

    if(
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    )
      return;

    const sinceLastTrade =
      ts - state.lastTradeTime;

    const allowTrade =
      sinceLastTrade >= MIN_TRADE_INTERVAL;

    if(
      ["BUY","SELL"].includes(plan.action) &&
      allowTrade &&
      !state.position
    ){

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

        state.limits.tradesToday++;

        if(state.position){

          state.position.maxDuration =
            computeDuration(plan.confidence)
            || MIN_TRADE_DURATION;

        }

        stateChanged = true;

      }

    }

    /* ================= EQUITY ================= */

    if(state.position){

      const unrealized =
        state.position.side === "LONG"
          ? (price - state.position.entry) * state.position.qty
          : (state.position.entry - price) * state.position.qty;

      state.equity =
        state.availableCapital + unrealized;

    }
    else{

      state.equity =
        state.availableCapital;

    }

    if(state.equity > state.peakEquity)
      state.peakEquity = state.equity;

    if(stateChanged)
      saveState(state);

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

    cashBalance:Number(s.cashBalance||0),

    availableCapital:Number(s.availableCapital||0),

    lockedCapital:Number(s.lockedCapital||0),

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
