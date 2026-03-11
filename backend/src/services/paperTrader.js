// ==========================================================
// Autonomous Paper Trading Engine — AI GOVERNED STABLE v6
// FIXED: Warmup + Stable Volatility + Safe Execution
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
const WARMUP_TICKS =
  Number(process.env.PAPER_WARMUP_TICKS || 25);

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
    realized:{ wins:0, losses:0, net:0 },
    limits:{ tradesToday:0, lossesToday:0 },
    executionStats:{ ticks:0, decisions:0, trades:0 },
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

/* ================= DAILY RESET ================= */

function resetDailyLimits(state){

  const today = new Date().toISOString().slice(0,10);

  if(state.lastResetDay !== today){
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
    state.lastResetDay = today;
  }

}

/* ================= SAVE ================= */

function scheduleSave(tenantId,state){

  const now = Date.now();

  if(!state._dirty) return;
  if(now - state._lastSave < SAVE_INTERVAL_MS)
    return;

  state._dirty = false;
  state._lastSave = now;

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

/* ================= CONFIG FROM DB ================= */

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
      positionMultiplier: Number(cfg.positionMultiplier || 1),
      strategyMode: cfg.strategyMode || "Balanced"
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
  const cfg = getTradingConfig(tenantId);

  if(!state.running) return;
  if(!cfg.enabled) return;
  if(cfg.tradingMode !== "paper") return;
  if(!Number.isFinite(price) || price <= 0) return;
  if(state._locked) return;

  state._locked = true;

  try{

    resetDailyLimits(state);

    state.executionStats.ticks++;

    orderFlowEngine.recordPrice({tenantId,price});
    counterfactualEngine.recordPrice({tenantId,price});
    correlationEngine.recordPrice({tenantId,symbol,price});

    const prev = state.lastPrice;

    if(prev){
      const change =
        Math.abs(price - prev) / prev;

      state.volatility =
        state.volatility * 0.9 + change * 0.1;
    }else{
      state.volatility = 0.003;
    }

    state.lastPrice = price;

    /* ============== WARMUP ============== */

    if(state.executionStats.ticks < WARMUP_TICKS){
      state._dirty = true;
      scheduleSave(tenantId,state);
      return;
    }

    if(state.limits.tradesToday >= cfg.maxTrades){
      state._dirty = true;
      scheduleSave(tenantId,state);
      return;
    }

    const plan =
      makeDecision({
        tenantId,
        symbol,
        last:price,
        paper:state,
        ticksSeen: state.executionStats.ticks,
        strategyMode: cfg.strategyMode
      }) || {
        action:"WAIT",
        confidence:0,
        edge:0,
        riskPct:0
      };

    plan.riskPct =
      (Number(cfg.riskPercent || 1.5) / 100) *
      Number(cfg.positionMultiplier || 1);

    state.executionStats.decisions++;

    state.decisions.push({
      time:ts,
      symbol,
      action:plan.action,
      confidence:Number(plan.confidence || 0),
      price,
      riskPct:Number(plan.riskPct || 0),
      volatility:Number(state.volatility || 0)
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

        const pnl = Number(exec.result.pnl || 0);

        state.trades.push({
          time:ts,
          symbol,
          side:plan.action,
          price,
          qty:Number(exec.result.qty || 0),
          profit:pnl
        });

        if(pnl > 0){
          state.realized.wins++;
        }else if(pnl < 0){
          state.realized.losses++;
          state.limits.lossesToday++;
        }

        state.realized.net += pnl;
        state.equity = Number(state.cashBalance || state.equity || 0);

        if(state.equity > state.peakEquity){
          state.peakEquity = state.equity;
        }

        if(state.trades.length > MAX_TRADES_MEMORY){
          state.trades =
            state.trades.slice(-MAX_TRADES_MEMORY);
        }
      }
    }

    state._dirty = true;
    scheduleSave(tenantId,state);

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
    unrealizedPnL:
      s.position
        ? (
            s.position.side === "SHORT"
              ? (s.position.entry - s.lastPrice) * s.position.qty
              : (s.lastPrice - s.position.entry) * s.position.qty
          )
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
    tenantId=>load(tenantId).decisions.slice(-50),
  hardReset:
    tenantId=>STATES.set(tenantId, defaultState())
};
