// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: AI GOVERNED STABLE v22
//
// ENHANCEMENTS
// - Minimum trade interval guard
// - Maximum trade duration guard
// - Prevents AI trade spam
// - Forces exit on long-running trades
//
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const memoryBrain = require("../../brainMemory/memoryBrain");
const { readDb } = require("../lib/db");

const ENGINE_START = Date.now();

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const MAX_TRADES_MEMORY = 500;
const MAX_DECISIONS_MEMORY = 200;

/* ================= TIMING GUARDS ================= */

const MIN_TRADE_INTERVAL = 30000;      // 30 seconds
const MAX_TRADE_DURATION = 20 * 60 * 1000; // 20 minutes

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
    lastPrice:null,
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

/* ================= LOAD ================= */

function load(tenantId){

  if(STATES.has(tenantId))
    return STATES.get(tenantId);

  const state = defaultState();

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
      maxTrades: Number(cfg.maxTrades || 5),
      riskPercent: Number(cfg.riskPercent || 1.5),
      positionMultiplier: Number(cfg.positionMultiplier || 1)
    };

  }catch{

    return {
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
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

  /* ================= CAPITAL GUARD ================= */

  if(state.cashBalance <= 0 || state.equity <= 0){
    console.warn("Paper account bankrupt — stopping engine");
    state.running = false;
    return;
  }

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

    /* ================= FORCE CLOSE IF TRADE TOO LONG ================= */

    if(state.position){

      const tradeAge =
        ts - state.position.time;

      if(tradeAge > MAX_TRADE_DURATION){

        executionEngine.executePaperOrder({
          tenantId,
          symbol,
          action:"CLOSE",
          price,
          state,
          ts
        });

        state.lastTradeTime = ts;

        return;
      }

    }

    /* ================= TRADE INTERVAL GUARD ================= */

    const sinceLastTrade =
      ts - state.lastTradeTime;

    const allowTrade =
      sinceLastTrade >= MIN_TRADE_INTERVAL;

    /* ================= AI DECISION ================= */

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

    state.decisions.push({
      time:ts,
      symbol,
      action:plan.action,
      confidence:plan.confidence || 0,
      price,
      riskPct:plan.riskPct
    });

    if(state.decisions.length > MAX_DECISIONS_MEMORY)
      state.decisions =
        state.decisions.slice(-MAX_DECISIONS_MEMORY);

    /* ================= EXECUTION ROUTING ================= */

    if(["BUY","SELL","CLOSE"].includes(plan.action) && allowTrade){

      let exec;

      if(cfg.tradingMode === "live"){

        exec =
          executionEngine.executeLiveOrder({
            tenantId,
            symbol,
            action:plan.action,
            price,
            riskPct:plan.riskPct,
            state,
            ts
          });

      }else{

        exec =
          executionEngine.executePaperOrder({
            tenantId,
            symbol,
            action:plan.action,
            price,
            riskPct:plan.riskPct,
            state,
            ts
          });

      }

      if(exec?.result && Number(exec.result.qty) > 0){

        state.executionStats.trades++;

        state.lastTradeTime = ts;

        const trade = {
          symbol,
          side:plan.action,
          entry:state.position?.entry || price,
          exit:price,
          price,
          qty:Number(exec.result.qty||0),
          pnl:Number(exec.result.pnl||0),
          time:ts,
          timeOpen:state.position?.time || ts
        };

        state.trades.push(trade);

        try{
          memoryBrain.recordTrade({
            tenantId,
            symbol,
            entry:trade.entry,
            exit:trade.exit,
            qty:trade.qty,
            pnl:trade.pnl,
            risk:plan.riskPct,
            confidence:plan.confidence || 0,
            edge:plan.edge || 0,
            volatility:state.volatility
          });
        }catch{}

        if(state.trades.length > MAX_TRADES_MEMORY)
          state.trades =
            state.trades.slice(-MAX_TRADES_MEMORY);

      }

    }

    /* ================= EQUITY ================= */

    if(state.position){

      const unrealized =
        state.position.side === "LONG"
          ? (price - state.position.entry) * state.position.qty
          : (state.position.entry - price) * state.position.qty;

      state.equity =
        state.cashBalance + unrealized;

    }
    else{

      state.equity =
        state.cashBalance;

    }

    if(state.equity > state.peakEquity)
      state.peakEquity = state.equity;

  }
  finally{

    state._locked = false;

  }

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId){

  const s = load(tenantId);

  return {

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
