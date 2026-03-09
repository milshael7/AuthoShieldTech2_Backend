// ==========================================================
// Autonomous Paper Trading Engine — AI GOVERNED STABLE v4
// FIXED: Reads config directly from DB (Control Panel Linked)
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
  path.join("/tmp", "paper_trader");

const MAX_TRADES_MEMORY = 500;
const MAX_DECISIONS_MEMORY = 200;
const SAVE_INTERVAL_MS = 5000;

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
    volatility:0.002,
    lastPrice:65000,
    realized:{ wins:0, losses:0, net:0 },
    limits:{ tradesToday:0, lossesToday:0 },
    executionStats:{ ticks:0, decisions:0, trades:0 },
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

/* ================= SAVE ================= */

function scheduleSave(tenantId,state){

  const now = Date.now();

  if(!state._dirty) return;
  if(now - state._lastSave < SAVE_INTERVAL_MS)
    return;

  state._dirty=false;
  state._lastSave=now;

  const file = statePath(tenantId);

  const snapshot =
    JSON.stringify(
      {...state,_dirty:undefined,_locked:undefined},
      null,
      2
    );

  setImmediate(()=>{
    try{
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp,snapshot);
      fs.renameSync(tmp,file);
    }catch{}
  });
}

/* ================= AI CONFIG FROM DB ================= */

function getTradingConfig(){

  try{
    const db = readDb();
    return db.tradingConfig || {
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
      riskPercent:1.5,
      positionMultiplier:1,
      strategyMode:"Balanced"
    };
  }catch{
    return {
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
      riskPercent:1.5,
      positionMultiplier:1,
      strategyMode:"Balanced"
    };
  }

}

/* ================= AI TICK ================= */

function tick(tenantId,symbol,price,ts=Date.now()){

  const state = load(tenantId);
  const cfg = getTradingConfig();

  if(!state.running || state._locked) return;
  if(!cfg.enabled) return;
  if(cfg.tradingMode !== "paper") return;

  state._locked = true;

  try{

    state.executionStats.ticks++;

    orderFlowEngine.recordPrice({tenantId,price});
    counterfactualEngine.recordPrice({tenantId,price});
    correlationEngine.recordPrice({tenantId,symbol,price});

    const prev = state.lastPrice;
    state.lastPrice = price;

    if(prev){
      const change =
        Math.abs(price-prev)/prev;
      state.volatility =
        state.volatility*0.9 + change*0.1;
    }

    if(state.limits.tradesToday >= cfg.maxTrades)
      return;

    const plan =
      makeDecision({
        tenantId,
        symbol,
        last:price,
        paper:state,
        ticksSeen: state.executionStats.ticks
      }) || { action:"WAIT", confidence:0, riskPct:0 };

    plan.riskPct =
      (Number(cfg.riskPercent || 1.5)/100)
      * Number(cfg.positionMultiplier || 1);

    state.executionStats.decisions++;

    state.decisions.push({
      time:ts,
      action:plan.action,
      confidence:plan.confidence,
      price,
      riskPct:plan.riskPct
    });

    if(state.decisions.length > MAX_DECISIONS_MEMORY){
      state.decisions =
        state.decisions.slice(-MAX_DECISIONS_MEMORY);
    }

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
        state.limits.tradesToday++;

        const pnl = exec.result.pnl || 0;

        state.trades.push({
          time:ts,
          side:plan.action,
          price,
          qty:exec.result.qty || 0,
          profit:pnl
        });

        if(pnl>0){
          state.realized.wins++;
        }
        else if(pnl<0){
          state.realized.losses++;
          state.limits.lossesToday++;
        }

        state.realized.net += pnl;

        if(state.trades.length > MAX_TRADES_MEMORY){
          state.trades =
            state.trades.slice(-MAX_TRADES_MEMORY);
        }
      }
    }

    state._dirty=true;
    scheduleSave(tenantId,state);

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
    unrealizedPnL:
      s.position
        ? (s.lastPrice-s.position.entry)
          * s.position.qty
        : 0,
    executionStats:s.executionStats,
    realized:s.realized,
    limits:s.limits
  }));

}

module.exports = {
  tick,
  snapshot,
  getDecisions:
    tenantId=>load(tenantId)
      .decisions.slice(-50),
  hardReset:
    tenantId=>STATES.set(
      tenantId,
      defaultState()
    )
};
