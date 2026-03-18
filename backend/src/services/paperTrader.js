// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v44.1 (Auto Dual Mode + Smart Runner TP + Confidence Sync Fix)
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* =========================================================
CONFIG
========================================================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const COOLDOWN_AFTER_TRADE =
  Number(process.env.TRADE_COOLDOWN_AFTER_TRADE || 30000);

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 100);

const MAX_DAILY_LOSSES =
  Number(process.env.TRADE_MAX_DAILY_LOSSES || 50);

/* HOLDING LOGIC */

const MIN_HOLD_TIME =
  Number(process.env.TRADE_MIN_HOLD_MS || 15000);

const MIN_TRADE_DURATION =
  Number(process.env.TRADE_MIN_DURATION_MS || 2 * 60 * 1000);

const MAX_TRADE_DURATION =
  Number(process.env.TRADE_MAX_DURATION_MS || 20 * 60 * 1000);

const MAX_EXTENSION_DURATION =
  Number(process.env.TRADE_MAX_EXTENSION_MS || 15 * 60 * 1000);

/* RISK */

const HARD_STOP_LOSS =
  Number(process.env.TRADE_HARD_STOP_LOSS || -0.0035);

const MIN_PROFIT_TO_TRAIL =
  Number(process.env.TRADE_MIN_PROFIT_TO_TRAIL || 0.0025);

/* DUAL MODE */

const STRUCTURE_LOOKBACK =
  Number(process.env.TRADE_STRUCTURE_LOOKBACK || 30);

const STRUCTURE_ENTRY_BUFFER =
  Number(process.env.TRADE_STRUCTURE_ENTRY_BUFFER || 0.0015);

const STRUCTURE_MIN_SWING =
  Number(process.env.TRADE_STRUCTURE_MIN_SWING || 0.0035);

const STRONG_TREND_BARS =
  Number(process.env.TRADE_STRONG_TREND_BARS || 5);

const LOSS_STREAK_SLOWDOWN =
  Number(process.env.TRADE_LOSS_STREAK_SLOWDOWN || 3);

const EXTRA_COOLDOWN_ON_LOSS_STREAK =
  Number(process.env.TRADE_EXTRA_COOLDOWN_ON_LOSS_STREAK || 90000);

/* SMART STRUCTURE EXIT */

const STRUCTURE_TARGET_BUFFER =
  Number(process.env.TRADE_STRUCTURE_TARGET_BUFFER || 0.0006);

const STRUCTURE_PROFIT_LOCK =
  Number(process.env.TRADE_STRUCTURE_PROFIT_LOCK || 0.45);

const STRUCTURE_MIN_LOCK_PNL =
  Number(process.env.TRADE_STRUCTURE_MIN_LOCK_PNL || 0.0015);

const STRUCTURE_BREAK_EVEN_PNL =
  Number(process.env.TRADE_STRUCTURE_BREAK_EVEN_PNL || 0.0020);

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
    lastMode:"SCALP",
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

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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
PRICE MEMORY
========================================================= */

const PRICE_HISTORY = new Map();

function recordPrice(tenantId, price){
  const key = tenantId || "__default__";

  if(!PRICE_HISTORY.has(key))
    PRICE_HISTORY.set(key,[]);

  const arr = PRICE_HISTORY.get(key);

  arr.push(price);

  if(arr.length > 120)
    arr.shift();

  return arr;
}

/* =========================================================
TREND / STRUCTURE DETECTION
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

  const m1 = prices[prices.length-1] - prices[prices.length-2];
  const m2 = prices[prices.length-2] - prices[prices.length-3];
  const m3 = prices[prices.length-3] - prices[prices.length-4];

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);
}

function detectHardMomentumBreak(prices, side){
  if(prices.length < 4) return false;

  const m1 = prices[prices.length-1] - prices[prices.length-2];
  const m2 = prices[prices.length-2] - prices[prices.length-3];

  if(side==="LONG")
    return m1 < 0 && m2 < 0;

  if(side==="SHORT")
    return m1 > 0 && m2 > 0;

  return false;
}

function getStructureZones(prices){

  if(prices.length < STRUCTURE_LOOKBACK){
    return null;
  }

  const slice = prices.slice(-STRUCTURE_LOOKBACK);
  const resistance = Math.max(...slice);
  const support = Math.min(...slice);
  const range = resistance - support;

  if(range <= 0)
    return null;

  const swingPct = range / support;

  return {
    resistance,
    support,
    range,
    swingPct,
    mid:(resistance + support) / 2
  };
}

function detectMarketBias(prices){

  if(prices.length < STRONG_TREND_BARS + 2)
    return "neutral";

  let up = 0;
  let down = 0;

  const start =
    Math.max(1, prices.length - (STRONG_TREND_BARS + 1));

  for(let i = start; i < prices.length; i++){
    const move = prices[i] - prices[i-1];
    if(move > 0) up++;
    else if(move < 0) down++;
  }

  if(up >= STRONG_TREND_BARS)
    return "up";

  if(down >= STRONG_TREND_BARS)
    return "down";

  if(up > down)
    return "up_soft";

  if(down > up)
    return "down_soft";

  return "neutral";
}

function chooseTradeMode(prices){

  const zones = getStructureZones(prices);

  if(!zones)
    return { mode:"SCALP", zones:null, bias:"neutral" };

  const bias = detectMarketBias(prices);

  if(
    zones.swingPct >= STRUCTURE_MIN_SWING &&
    (
      bias === "up" ||
      bias === "down" ||
      bias === "up_soft" ||
      bias === "down_soft"
    )
  ){
    return { mode:"STRUCTURE", zones, bias };
  }

  return { mode:"SCALP", zones, bias };
}

function buildStructurePlan({ price, zones, bias, symbol }){

  if(!zones)
    return { action:"WAIT", mode:"STRUCTURE", reason:"NO_ZONES" };

  const distToResistance =
    Math.abs(zones.resistance - price) / price;

  const distToSupport =
    Math.abs(price - zones.support) / price;

  const nearResistance =
    distToResistance <= STRUCTURE_ENTRY_BUFFER;

  const nearSupport =
    distToSupport <= STRUCTURE_ENTRY_BUFFER;

  const inMiddle =
    price > (zones.support + zones.range * 0.3) &&
    price < (zones.resistance - zones.range * 0.3);

  if(inMiddle){
    return {
      action:"WAIT",
      mode:"STRUCTURE",
      reason:"MID_ZONE_BLOCK",
      support:zones.support,
      resistance:zones.resistance
    };
  }

  if(
    (bias === "down" || bias === "down_soft") &&
    nearResistance
  ){
    return {
      symbol,
      action:"SELL",
      mode:"STRUCTURE",
      confidence:0.72,
      riskPct:0.01,
      targetPrice:zones.support,
      support:zones.support,
      resistance:zones.resistance
    };
  }

  if(
    (bias === "up" || bias === "up_soft") &&
    nearSupport
  ){
    return {
      symbol,
      action:"BUY",
      mode:"STRUCTURE",
      confidence:0.72,
      riskPct:0.01,
      targetPrice:zones.resistance,
      support:zones.support,
      resistance:zones.resistance
    };
  }

  return {
    action:"WAIT",
    mode:"STRUCTURE",
    reason:"ZONE_NOT_READY",
    support:zones.support,
    resistance:zones.resistance
  };
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
POSITION MANAGEMENT
========================================================= */

function handleStructurePosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  pos,
  pnl,
  elapsed,
  prices
}){

  const strongTrend = detectTrendRun(prices,pos.side);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices,pos.side);

  if(!Number.isFinite(pos.bestPnl))
    pos.bestPnl = 0;

  if(pnl > pos.bestPnl)
    pos.bestPnl = pnl;

  if(!Number.isFinite(pos.lockedProfitFloor))
    pos.lockedProfitFloor = NaN;

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(elapsed < MIN_HOLD_TIME)
    return false;

  const targetPrice = safeNum(pos.targetPrice,NaN);

  if(
    Number.isFinite(targetPrice) &&
    !pos.targetReached
  ){
    const longHit =
      pos.side === "LONG" &&
      price >= targetPrice * (1 - STRUCTURE_TARGET_BUFFER);

    const shortHit =
      pos.side === "SHORT" &&
      price <= targetPrice * (1 + STRUCTURE_TARGET_BUFFER);

    if(longHit || shortHit){
      pos.targetReached = true;
      pos.maxDuration =
        Math.min(
          pos.maxDuration + 60000,
          computeDuration(1) + MAX_EXTENSION_DURATION
        );
    }
  }

  if(pos.targetReached){

    if(pos.bestPnl >= STRUCTURE_BREAK_EVEN_PNL){

      const breakEvenFloor =
        pos.side === "LONG"
          ? pos.entry * 1.0002
          : pos.entry * 0.9998;

      if(pos.side === "LONG"){
        pos.lockedProfitFloor =
          Number.isFinite(pos.lockedProfitFloor)
            ? Math.max(pos.lockedProfitFloor, breakEvenFloor)
            : breakEvenFloor;
      }else{
        pos.lockedProfitFloor =
          Number.isFinite(pos.lockedProfitFloor)
            ? Math.min(pos.lockedProfitFloor, breakEvenFloor)
            : breakEvenFloor;
      }

    }

    if(pos.bestPnl >= STRUCTURE_MIN_LOCK_PNL){

      const lockPct =
        strongTrend ? 0.30 : STRUCTURE_PROFIT_LOCK;

      const protectedPnl =
        pos.bestPnl * lockPct;

      const floorFromPnl =
        pos.side === "LONG"
          ? pos.entry * (1 + protectedPnl)
          : pos.entry * (1 - protectedPnl);

      if(pos.side === "LONG"){
        pos.lockedProfitFloor =
          Number.isFinite(pos.lockedProfitFloor)
            ? Math.max(pos.lockedProfitFloor, floorFromPnl)
            : floorFromPnl;
      }else{
        pos.lockedProfitFloor =
          Number.isFinite(pos.lockedProfitFloor)
            ? Math.min(pos.lockedProfitFloor, floorFromPnl)
            : floorFromPnl;
      }

    }

    if(Number.isFinite(pos.lockedProfitFloor)){
      if(pos.side === "LONG" && price <= pos.lockedProfitFloor)
        return closeTrade({tenantId,state,symbol,price,ts});

      if(pos.side === "SHORT" && price >= pos.lockedProfitFloor)
        return closeTrade({tenantId,state,symbol,price,ts});
    }

    if(pnl > 0 && hardBreak && !strongTrend)
      return closeTrade({tenantId,state,symbol,price,ts});

    if(pnl > 0 && momentumWeak && !strongTrend)
      return closeTrade({tenantId,state,symbol,price,ts});

    if(strongTrend && pnl > 0){
      pos.maxDuration =
        Math.min(
          pos.maxDuration + 30000,
          computeDuration(1) + MAX_EXTENSION_DURATION
        );
    }

    if(elapsed >= pos.maxDuration)
      return closeTrade({tenantId,state,symbol,price,ts});

    return false;
  }

  if(pnl > 0 && hardBreak && !strongTrend)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(strongTrend && pnl > 0){
    pos.maxDuration =
      Math.min(
        pos.maxDuration + 30000,
        computeDuration(1) + MAX_EXTENSION_DURATION
      );
  }

  if(elapsed >= pos.maxDuration)
    return closeTrade({tenantId,state,symbol,price,ts});

  return false;
}

function handleScalpPosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  pos,
  pnl,
  elapsed,
  prices
}){

  const strongTrend = detectTrendRun(prices,pos.side);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices,pos.side);

  if(!pos.bestPnl) pos.bestPnl = 0;
  if(pnl > pos.bestPnl) pos.bestPnl = pnl;

  if(pnl <= HARD_STOP_LOSS)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(elapsed < MIN_HOLD_TIME)
    return false;

  if(strongTrend && pnl > 0){
    pos.maxDuration =
      Math.min(
        pos.maxDuration + 30000,
        computeDuration(1) + MAX_EXTENSION_DURATION
      );
  }

  if(
    pnl > MIN_PROFIT_TO_TRAIL &&
    momentumWeak &&
    !strongTrend
  ){
    return closeTrade({tenantId,state,symbol,price,ts});
  }

  if(pnl > 0 && hardBreak && !strongTrend)
    return closeTrade({tenantId,state,symbol,price,ts});

  if(elapsed >= pos.maxDuration)
    return closeTrade({tenantId,state,symbol,price,ts});

  return false;
}

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

  if(pos.mode === "STRUCTURE"){
    return handleStructurePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      pos,
      pnl,
      elapsed,
      prices
    });
  }

  return handleScalpPosition({
    tenantId,
    state,
    symbol,
    price,
    ts,
    pos,
    pnl,
    elapsed,
    prices
  });
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
OPEN POSITION
========================================================= */

function openTrade({
  tenantId,
  state,
  symbol,
  action,
  mode,
  plan,
  price,
  ts
}){

  const exec =
    executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action,
      price,
      riskPct:Number(plan.riskPct || 0.01),
      confidence:Number(plan.confidence || 0.5),
      state,
      ts
    });

  if(exec?.result){

    state.executionStats.trades++;
    state.limits.tradesToday++;
    state.lastMode = mode;

    if(state.position){

      state.position.mode = mode;
      state.position.bestPnl = 0;
      state.position.targetPrice =
        safeNum(plan.targetPrice, NaN);
      state.position.structureSupport =
        safeNum(plan.support, NaN);
      state.position.structureResistance =
        safeNum(plan.resistance, NaN);
      state.position.targetReached = false;
      state.position.lockedProfitFloor = NaN;
      state.position.maxDuration =
        mode === "STRUCTURE"
          ? computeDuration(Math.max(0.85, safeNum(plan.confidence,0.72)))
          : computeDuration(plan.confidence);

    }

    return true;
  }

  return false;
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

    const prices = recordPrice(tenantId,price);

    if(prev){
      const change = Math.abs(price-prev)/prev;

      state.volatility =
        Math.max(
          0.0005,
          state.volatility*0.9 + change*0.1
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

    let cooldown =
      COOLDOWN_AFTER_TRADE;

    if(state.limits.lossesToday >= LOSS_STREAK_SLOWDOWN){
      cooldown += EXTRA_COOLDOWN_ON_LOSS_STREAK;
    }

    if(ts - state.lastTradeTime < cooldown)
      return;

    if(
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    )
      return;

    const modePick =
      chooseTradeMode(prices);

    let plan = { action:"WAIT" };

    if(modePick.mode === "STRUCTURE"){
      plan = buildStructurePlan({
        price,
        zones:modePick.zones,
        bias:modePick.bias,
        symbol
      });
    }

    if(!["BUY","SELL"].includes(plan.action)){

      const scalpPlan =
        makeDecision({
          tenantId,
          symbol,
          last:price,
          paper:state
        }) || {action:"WAIT"};

      plan = {
        ...scalpPlan,
        mode:"SCALP"
      };
    }

    state.executionStats.decisions++;
    recordDecision(state,{
      ...plan,
      mode: plan.mode || modePick.mode,
      price,
      volatility: state.volatility
    });

    if(!["BUY","SELL"].includes(plan.action))
      return;

    openTrade({
      tenantId,
      state,
      symbol,
      action:plan.action,
      mode:plan.mode || "SCALP",
      plan,
      price,
      ts
    });

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
