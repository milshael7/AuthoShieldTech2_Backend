// ==========================================================
// Autonomous Paper Trading Engine — AI GOVERNED STABLE v18
// FIXED: crash protection + stable lock + telemetry safety
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const memoryBrain = require("../../brainMemory/memoryBrain");
const { readDb } = require("../lib/db");

/* ================= ENGINE START ================= */

const ENGINE_START = Date.now();

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

    memoryBrain.recordMarketState({
      tenantId,
      symbol,
      price,
      volatility:state.volatility
    });

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

    memoryBrain.recordSignal({
      tenantId,
      symbol,
      action:plan.action,
      confidence:plan.confidence || 0,
      edge:plan.edge || 0,
      price,
      volatility:state.volatility
    });

    if(state.decisions.length > MAX_DECISIONS_MEMORY)
      state.decisions =
        state.decisions.slice(-MAX_DECISIONS_MEMORY);

    /* ================= EXECUTION ================= */

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

        const trade = {
          time:ts,
          symbol,
          side:plan.action,
          price,
          qty:Number(exec.result.qty||0),
          pnl:Number(exec.result.pnl||0)
        };

        state.trades.push(trade);

        memoryBrain.recordTrade({
          tenantId,
          symbol,
          entry:price,
          exit:price,
          qty:trade.qty,
          pnl:trade.pnl,
          risk:plan.riskPct,
          confidence:plan.confidence || 0,
          edge:plan.edge || 0,
          volatility:state.volatility
        });

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
  catch(err){

    console.error("AI engine error:",err.message);

  }
  finally{

    state._locked = false;

  }

}

/* ================= TELEMETRY ================= */

function getTelemetry(state){

  const uptime =
    Math.floor((Date.now() - ENGINE_START) / 1000);

  const decisions =
    state.executionStats.decisions || 0;

  const decisionsPerMinute =
    uptime > 0
      ? (decisions / uptime) * 60
      : 0;

  return {

    uptime,
    decisionsPerMinute,
    memoryUsage:process.memoryUsage().rss

  };

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId){

  const s = load(tenantId);

  return {

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
    limits:s.limits,
    telemetry:getTelemetry(s)

  };

}

/* ================= EXPORT ================= */

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
