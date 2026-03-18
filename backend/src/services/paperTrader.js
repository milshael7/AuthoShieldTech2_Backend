// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v42 (Trend Holding + Smart Exit Upgrade)
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* =========================================================
CONFIG
========================================================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const COOLDOWN_AFTER_TRADE =
  Number(process.env.TRADE_COOLDOWN_AFTER_TRADE || 30000); // faster re-entry

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 100);

const MAX_DAILY_LOSSES =
  Number(process.env.TRADE_MAX_DAILY_LOSSES || 50);

/* HOLDING LOGIC */

const MIN_HOLD_TIME =
  Number(process.env.TRADE_MIN_HOLD_MS || 15000); // 15 sec minimum hold

const MIN_TRADE_DURATION =
  Number(process.env.TRADE_MIN_DURATION_MS || 2 * 60 * 1000);

const MAX_TRADE_DURATION =
  Number(process.env.TRADE_MAX_DURATION_MS || 20 * 60 * 1000);

const MAX_EXTENSION_DURATION =
  Number(process.env.TRADE_MAX_EXTENSION_MS || 15 * 60 * 1000);

/* RISK */

const HARD_STOP_LOSS =
  Number(process.env.TRADE_HARD_STOP_LOSS || -0.0035); // slightly wider

const MIN_PROFIT_TO_TRAIL =
  Number(process.env.TRADE_MIN_PROFIT_TO_TRAIL || 0.0025); // let trades breathe

/* =========================================================
STATE
========================================================= */

function defaultState(){
  return{
    running:true,
    cashBalance:START_BAL,
    availableCapital:START_BAL,
    lockedCapital:0,
    position:null,
    trades:[],
    decisions:[],
    volatility:0.003,
    lastPrice:60000,
    lastTradeTime:0,
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

function load(tenantId){
  if(STATES.has(tenantId))
    return STATES.get(tenantId);

  const state = defaultState();
  STATES.set(tenantId,state);
  return state;
}

/* =========================================================
HELPERS
========================================================= */

function recordDecision(state, plan){
  state.decisions.push({
    ...plan,
    time: Date.now()
  });

  if(state.decisions.length > 200)
    state.decisions.shift();
}

function snapshot(tenantId){
  return load(tenantId);
}

function getDecisions(tenantId){
  return load(tenantId).decisions || [];
}

/* =========================================================
TREND DETECTION
========================================================= */

function detectTrendRun(prices, side){
  if(prices.length < 4) return false;

  let run = 0;

  for(let i = prices.length-1; i > 0; i--){
    const move = prices[i] - prices[i-1];

    if(side==="LONG" && move > 0) run++;
    else if(side==="SHORT" && move < 0) run++;
    else break;

    if(run >= 3) return true;
  }

  return false;
}

function detectMomentumWeakening(prices){
  if(prices.length < 5) return false;

  const m1 = prices.at(-1) - prices.at(-2);
  const m2 = prices.at(-2) - prices.at(-3);
  const m3 = prices.at(-3) - prices.at(-4);

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);
}

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_HISTORY = new Map();

function recordPrice(tenantId, price){
  const key = tenantId || "__default__";

  if(!PRICE_HISTORY.has(key))
    PRICE_HISTORY.set(key,[]);

  const arr = PRICE_HISTORY.get(key);

  arr.push(price);

  if(arr.length > 60)
    arr.shift();

  return arr;
}

/* =========================================================
CLOSE TRADE
========================================================= */

function closeTrade({tenantId,state,symbol,price,ts}){

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

  const pnl = Number(closed.result.pnl || 0);

  if(pnl < 0)
    state.limits.lossesToday++;

  state.lastTradeTime = ts;

  return true;
}

/* =========================================================
POSITION MANAGEMENT (UPGRADED)
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
    pos.side==="LONG"
      ? (price-pos.entry)/pos.entry
      : (pos.entry-price)/pos.entry;

  const prices = recordPrice(tenantId,price);

  const strongTrend = detectTrendRun(prices,pos.side);
  const momentumWeak = detectMomentumWeakening(prices);

  if(!pos.bestPnl) pos.bestPnl = 0;
  if(pnl > pos.bestPnl) pos.bestPnl = pnl;

  /* ================= HARD STOP ================= */

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* ================= MIN HOLD (NEW) ================= */

  if(elapsed < MIN_HOLD_TIME)
    return false;

  /* ================= LET PROFITS RUN ================= */

  if(strongTrend && pnl > 0){
    pos.maxDuration += 30000; // extend 30s
  }

  /* ================= SMART EXIT ================= */

  if(
    pnl > MIN_PROFIT_TO_TRAIL &&
    momentumWeak &&
    !strongTrend
  ){
    return closeTrade({tenantId,state,symbol,price,ts});
  }

  /* ================= TIME EXIT ================= */

  if(elapsed >= pos.maxDuration)
    return closeTrade({tenantId,state,symbol,price,ts});

  return false;
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
TICK ENGINE
========================================================= */

function tick(tenantId,symbol,price,ts=Date.now()){

  const state = load(tenantId);

  if(!state.running) return;
  if(!Number.isFinite(price) || price<=0) return;
  if(state._locked) return;

  state._locked = true;

  try{

    const prev = state.lastPrice;
    state.lastPrice = price;

    if(prev){
      const change = Math.abs(price-prev)/prev;

      state.volatility =
        Math.max(
          0.0005,
          state.volatility*0.9 + change*0.1
        );
    }

    state.executionStats.ticks++;

    /* HANDLE OPEN POSITION */

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

    /* ENTRY FILTERS */

    if(ts - state.lastTradeTime < COOLDOWN_AFTER_TRADE)
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
        paper:state
      }) || {action:"WAIT"};

    state.executionStats.decisions++;
    recordDecision(state,plan);

    if(!["BUY","SELL"].includes(plan.action))
      return;

    /* EXECUTION */

    const exec =
      executionEngine.executePaperOrder({
        tenantId,
        symbol,
        action:plan.action,
        price,
        riskPct:Number(plan.riskPct || 0.01),
        state,
        ts
      });

    if(exec?.result){

      state.executionStats.trades++;
      state.limits.tradesToday++;

      if(state.position){

        state.position.maxDuration =
          computeDuration(plan.confidence);

        state.position.bestPnl = 0;

      }

    }

  }
  finally{
    state._locked = false;
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  tick,
  snapshot,
  getDecisions
};
