// ==========================================================
// MARKET ENGINE — REALTIME SIMULATED EXCHANGE
// Multi-Tenant • High Frequency • Deterministic
// UPGRADED: AI Scheduler + Stable Engine
// ==========================================================

const paperTrader = require("./paperTrader");

const TENANTS = new Map();

/* ================= CONFIG ================= */

const SYMBOLS = {
  BTCUSDT: { start: 65000, vol: 0.0025 },
  ETHUSDT: { start: 3500, vol: 0.003 },
  SOLUSDT: { start: 150, vol: 0.004 },
  EURUSD: { start: 1.08, vol: 0.0004 },
  GBPUSD: { start: 1.27, vol: 0.0004 },
  SPX: { start: 5100, vol: 0.0007 },
  NASDAQ: { start: 17800, vol: 0.0008 },
  GOLD: { start: 2050, vol: 0.0006 }
};

const CANDLE_MS = 60000;
const MAX_CANDLES = 2000;

const MARKET_TICK_MS = 200;
const AI_TICK_MS = 2000;

/* ================= UTIL ================= */

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function randomWalk(price,vol){
  const drift = (Math.random() - 0.5) * 2 * vol;
  const next = price * (1 + drift);
  return Number(clamp(next,0.0000001,1e12).toFixed(8));
}

/* ================= TENANT INIT ================= */

function registerTenant(tenantId){

  if(TENANTS.has(tenantId)) return;

  const state = {
    prices:{},
    candles:{},
    lastCandleTime:{}
  };

  for(const sym of Object.keys(SYMBOLS)){

    const start = SYMBOLS[sym].start;

    state.prices[sym] = start;

    state.candles[sym] = [{
      t:Date.now(),
      o:start,
      h:start,
      l:start,
      c:start
    }];

    state.lastCandleTime[sym] = Date.now();
  }

  TENANTS.set(tenantId,state);
}

/* ================= TENANT LIST ================= */

function getRegisteredTenants(){
  return Array.from(TENANTS.keys());
}

/* ================= MARKET TICK ================= */

function tickTenant(tenantId){

  const state = TENANTS.get(tenantId);
  if(!state) return;

  for(const sym of Object.keys(SYMBOLS)){

    const config = SYMBOLS[sym];
    const prev = state.prices[sym];
    const next = randomWalk(prev,config.vol);

    state.prices[sym] = next;

    updateCandle(state,sym,next);
  }
}

/* ================= AI DECISION LOOP ================= */

function runAiForTenant(tenantId){

  const state = TENANTS.get(tenantId);
  if(!state) return;

  try{

    const btc = state.prices["BTCUSDT"];

    if(btc){

      paperTrader.tick(
        tenantId,
        "BTCUSDT",
        Number(btc)
      );

    }

  }catch{}
}

/* ================= CANDLE ENGINE ================= */

function updateCandle(state,symbol,price){

  const now = Date.now();
  const arr = state.candles[symbol];
  const last = arr[arr.length - 1];

  if(now - last.t >= CANDLE_MS){

    const newCandle = {
      t:now,
      o:last.c,
      h:last.c,
      l:last.c,
      c:last.c
    };

    arr.push(newCandle);

    if(arr.length > MAX_CANDLES){
      arr.splice(0,arr.length - MAX_CANDLES);
    }
  }

  const cur = arr[arr.length - 1];

  cur.h = Math.max(cur.h,price);
  cur.l = Math.min(cur.l,price);
  cur.c = price;
}

/* ================= SNAPSHOT ================= */

function getMarketSnapshot(tenantId){

  const state = TENANTS.get(tenantId);
  if(!state) return {};

  const out = {};

  for(const sym of Object.keys(state.prices)){
    out[sym] = { price:state.prices[sym] };
  }

  return out;
}

/* ================= CANDLES ================= */

function getCandles(tenantId,symbol,limit=200){

  const state = TENANTS.get(tenantId);
  if(!state) return [];

  const arr = state.candles[symbol] || [];

  return arr.slice(-limit).map(c => ({
    time: Math.floor(c.t/1000),
    open:c.o,
    high:c.h,
    low:c.l,
    close:c.c
  }));
}

/* ================= PRICE ================= */

function getPrice(tenantId,symbol){

  const state = TENANTS.get(tenantId);
  if(!state) return null;

  return state.prices[symbol] || null;
}

/* ================= GLOBAL MARKET LOOP ================= */

setInterval(()=>{

  for(const tenantId of TENANTS.keys()){
    try{
      tickTenant(tenantId);
    }catch{}
  }

},MARKET_TICK_MS);

/* ================= GLOBAL AI LOOP ================= */

setInterval(()=>{

  for(const tenantId of TENANTS.keys()){
    try{
      runAiForTenant(tenantId);
    }catch{}
  }

},AI_TICK_MS);

/* ================= EXPORT ================= */

module.exports = {
  registerTenant,
  getRegisteredTenants,
  getMarketSnapshot,
  getCandles,
  getPrice
};
