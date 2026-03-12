// ==========================================================
// Autonomous Paper Trading Engine — AI GOVERNED STABLE v13
// FIXED: correct decision context + momentum sync
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const { readDb } = require("../lib/db");

/* ================= CONFIG ================= */

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const MAX_TRADES_MEMORY = 500;
const MAX_DECISIONS_MEMORY = 200;

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
    realized:{wins:0,losses:0,net:0},
    limits:{tradesToday:0,lossesToday:0},
    executionStats:{ticks:0,decisions:0,trades:0},
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
  if(cfg.tradingMode !== "paper") return;
  if(!Number.isFinite(price) || price<=0) return;
  if(state._locked) return;

  state._locked = true;

  try{

    const prev = state.lastPrice;

    /* ===== update price ===== */

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

    /* ===== AI decision ===== */

    const plan =
      makeDecision({
        tenantId,
        symbol,
        price,
        lastPrice: prev,
        volatility: state.volatility,
        ticksSeen: state.executionStats.ticks
      }) || {
        action:"WAIT",
        confidence:0,
        riskPct:0
      };

    state.executionStats.decisions++;

    state.decisions.push({
      time:ts,
      symbol,
      action:plan.action,
      confidence:plan.confidence,
      price
    });

    if(state.decisions.length > MAX_DECISIONS_MEMORY)
      state.decisions =
        state.decisions.slice(-MAX_DECISIONS_MEMORY);

    /* ===== execution ===== */

    if(["BUY","SELL","CLOSE"].includes(plan.action)){

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

        state.trades.push({
          time:ts,
          symbol,
          side:plan.action,
          price,
          qty:Number(exec.result.qty||0),
          profit:Number(exec.result.pnl||0)
        });

        if(state.trades.length > MAX_TRADES_MEMORY)
          state.trades =
            state.trades.slice(-MAX_TRADES_MEMORY);

      }

    }

    /* ===== equity ===== */

    if(state.position){

      const unrealized =
        (price - state.position.entry)
        * state.position.qty;

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

  return JSON.parse(JSON.stringify({

    cashBalance:s.cashBalance,
    equity:s.equity,
    peakEquity:s.peakEquity,
    position:s.position,
    trades:s.trades,
    decisions:s.decisions,
    lastPrice:s.lastPrice,
    volatility:s.volatility,
    executionStats:s.executionStats,
    realized:s.realized,
    limits:s.limits

  }));

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
