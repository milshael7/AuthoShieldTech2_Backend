// ==========================================================
// Autonomous Paper Trading Engine — AI GOVERNED STABLE v8
// FIXED: Faster warmup + optional unlimited paper trades
// ADDED: manual executeOrder() support
// ==========================================================

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");
const { readDb } = require("../lib/db");

const orderFlowEngine = require("./orderFlowEngine");
const counterfactualEngine = require("./counterfactualEngine");
const correlationEngine = require("./correlationEngine");

/* ================= CONFIG ================= */

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const BASE_PATH =
  process.env.PAPER_STATE_DIR ||
  path.join("/tmp","paper_trader");

const MAX_TRADES_MEMORY = 500;
const MAX_DECISIONS_MEMORY = 200;

const SAVE_INTERVAL_MS = 5000;

const WARMUP_TICKS =
  Number(process.env.PAPER_WARMUP_TICKS || 8);

/* ================= FS ================= */

function ensureDir(p){
  if(!fs.existsSync(p))
    fs.mkdirSync(p,{recursive:true});
}

function statePath(tenantId){
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH,`paper_${tenantId}.json`);
}

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
    lastResetDay:null,
    _dirty:false,
    _lastSave:0,
    _locked:false
  };
}

const STATES = new Map();

/* ================= LOAD ================= */

function load(tenantId){

  if(STATES.has(tenantId))
    return STATES.get(tenantId);

  let state = defaultState();
  const file = statePath(tenantId);

  try{
    if(fs.existsSync(file)){
      const raw =
        JSON.parse(fs.readFileSync(file,"utf-8"));
      state = {...state,...raw};
    }
  }catch{}

  STATES.set(tenantId,state);
  return state;
}

/* ================= MANUAL ORDER ================= */

function executeOrder({
  tenantId,
  symbol,
  side,
  size,
  stopLoss,
  takeProfit
}){

  const state = load(tenantId);

  const price =
    state.lastPrice || 0;

  if(!price)
    throw new Error("Market price unavailable");

  const exec =
    executionEngine.executePaperOrder({

      tenantId,
      symbol,
      action:side,
      price,
      riskPct:0,
      state,
      ts:Date.now(),
      qty:Number(size)

    });

  if(exec?.result){

    const pnl =
      Number(exec.result.pnl||0);

    state.executionStats.trades++;

    state.trades.push({
      time:Date.now(),
      symbol,
      side,
      price,
      qty:Number(exec.result.qty||0),
      profit:pnl
    });

    state.realized.net += pnl;

    state._dirty=true;
  }

  return exec;
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

  state._locked=true;

  try{

    state.executionStats.ticks++;

    const plan =
      makeDecision({
        tenantId,
        symbol,
        last:price,
        paper:state,
        ticksSeen:state.executionStats.ticks
      }) || {
        action:"WAIT",
        confidence:0,
        riskPct:0
      };

    state.executionStats.decisions++;

    if(["BUY","SELL","CLOSE"].includes(plan.action)){

      executionEngine.executePaperOrder({
        tenantId,
        symbol,
        action:plan.action,
        price,
        riskPct:plan.riskPct,
        state,
        ts
      });

      state.executionStats.trades++;

    }

  }
  finally{
    state._locked=false;
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
  executeOrder,

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
