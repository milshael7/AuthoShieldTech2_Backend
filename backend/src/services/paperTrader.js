// ==========================================================
// FILE: backend/src/services/paperTrader.js
// MODULE: Autonomous Paper Trading Engine
// VERSION: v41 (Institutional Exit Optimization Engine)
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* =========================================================
CONFIG
========================================================= */

const START_BAL =
  Number(process.env.PAPER_START_BALANCE || 100000);

const COOLDOWN_AFTER_TRADE =
  Number(process.env.TRADE_COOLDOWN_AFTER_TRADE || 120000);

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 40);

const MAX_DAILY_LOSSES =
  Number(process.env.TRADE_MAX_DAILY_LOSSES || 12);

const MIN_TRADE_DURATION =
  Number(process.env.TRADE_MIN_DURATION_MS || 10 * 60 * 1000);

const MAX_TRADE_DURATION =
  Number(process.env.TRADE_MAX_DURATION_MS || 15 * 60 * 1000);

const MAX_EXTENSION_DURATION =
  Number(process.env.TRADE_MAX_EXTENSION_MS || 10 * 60 * 1000);

const HARD_STOP_LOSS =
  Number(process.env.TRADE_HARD_STOP_LOSS || -0.0025);

const STRONG_TREND_CANDLES =
  Number(process.env.TRADE_STRONG_TREND_CANDLES || 4);

const MIN_PROFIT_TO_TRAIL =
  Number(process.env.TRADE_MIN_PROFIT_TO_TRAIL || 0.001);

const MAX_PROFIT_LOCK =
  Number(process.env.TRADE_MAX_PROFIT_LOCK || 0.80);

const MIN_PROFIT_LOCK =
  Number(process.env.TRADE_MIN_PROFIT_LOCK || 0.35);

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

  if(arr.length > 50)
    arr.shift();

  return arr;

}

/* =========================================================
TREND DETECTION
========================================================= */

function detectTrendRun(prices,side){

  if(prices.length < STRONG_TREND_CANDLES + 1)
    return false;

  let run = 0;

  for(let i = prices.length-1; i > 0; i--){

    const move = prices[i] - prices[i-1];

    if(side==="LONG" && move>0) run++;
    else if(side==="SHORT" && move<0) run++;
    else break;

    if(run >= STRONG_TREND_CANDLES)
      return true;

  }

  return false;

}

function detectMomentumWeakening(prices){

  if(prices.length < 6)
    return false;

  const m1 = prices[prices.length-1] - prices[prices.length-2];
  const m2 = prices[prices.length-2] - prices[prices.length-3];
  const m3 = prices[prices.length-3] - prices[prices.length-4];

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);

}

function detectHardMomentumBreak(prices,side){

  if(prices.length < 4)
    return false;

  const m1 = prices[prices.length-1] - prices[prices.length-2];
  const m2 = prices[prices.length-2] - prices[prices.length-3];

  if(side==="LONG") return m1<0 && m2<0;
  if(side==="SHORT") return m1>0 && m2>0;

  return false;

}

/* =========================================================
PROFIT LOCK MODEL
========================================================= */

function computeProfitLock(bestPnl,volatility,strongTrend){

  if(bestPnl >= 0.02)
    return MAX_PROFIT_LOCK;

  if(strongTrend)
    return 0.75;

  if(volatility > 0.01)
    return 0.55;

  if(bestPnl >= 0.01)
    return 0.65;

  if(bestPnl >= 0.005)
    return 0.50;

  return MIN_PROFIT_LOCK;

}

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

  if(!closed?.result)
    return false;

  const pnl = Number(closed.result.pnl || 0);

  if(pnl < 0)
    state.limits.lossesToday++;

  state.lastTradeTime = ts;

  return true;

}

/* =========================================================
POSITION MANAGEMENT
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

  const prices =
    recordPrice(tenantId,price);

  const strongTrend =
    detectTrendRun(prices,pos.side);

  const momentumWeak =
    detectMomentumWeakening(prices);

  const momentumBreak =
    detectHardMomentumBreak(prices,pos.side);

  if(!pos.bestPnl)
    pos.bestPnl = 0;

  if(pnl > pos.bestPnl)
    pos.bestPnl = pnl;

  /* HARD STOP */

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* PROFIT LOCK */

  if(pos.bestPnl > MIN_PROFIT_TO_TRAIL){

    const lockPct =
      computeProfitLock(
        pos.bestPnl,
        state.volatility,
        strongTrend
      );

    const floor =
      pos.bestPnl * lockPct;

    if(pnl < floor)
      return closeTrade({tenantId,state,symbol,price,ts});

  }

  /* EARLY WEAKNESS EXIT */

  if(pnl > 0 && momentumWeak)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(pnl > 0 && momentumBreak)
    return closeTrade({tenantId,state,symbol,price,ts});

  /* MOMENTUM EXTENSION */

  if(strongTrend && pnl > 0){

    const extended =
      pos.maxDuration + MAX_EXTENSION_DURATION;

    pos.maxDuration =
      Math.min(extended,pos.maxDuration + 60000);

  }

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
TICK
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

    if(ts - state.lastTradeTime < COOLDOWN_AFTER_TRADE)
      return;

    if(
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    )
      return;

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

module.exports = {
  tick
};
