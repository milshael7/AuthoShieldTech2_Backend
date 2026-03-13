// ==========================================================
// MARKET ENGINE — Persistent Real-Time Exchange Simulator
// INSTITUTIONAL STABLE VERSION v3
// FIXED: candle persistence + buffered saves + safe restore
// ==========================================================

const fs = require("fs");
const path = require("path");

const paperTrader = require("./paperTrader");

/* ================= STORAGE ================= */

const STATE_DIR =
  process.env.MARKET_STATE_DIR ||
  path.join("/tmp","market_engine");

function ensureDir(){
  if(!fs.existsSync(STATE_DIR))
    fs.mkdirSync(STATE_DIR,{recursive:true});
}

function stateFile(tenantId){
  ensureDir();
  return path.join(STATE_DIR,`market_${tenantId}.json`);
}

/* ================= CONFIG ================= */

const SYMBOLS = {
  BTCUSDT:{start:65000,vol:0.0025},
  ETHUSDT:{start:3500,vol:0.003},
  SOLUSDT:{start:150,vol:0.004},
  EURUSD:{start:1.08,vol:0.0004},
  GBPUSD:{start:1.27,vol:0.0004},
  SPX:{start:5100,vol:0.0007},
  NASDAQ:{start:17800,vol:0.0008},
  GOLD:{start:2050,vol:0.0006}
};

const MARKET_TICK_MS = 200;
const AI_TICK_MS = 1000;

const CANDLE_MS = 60000;
const MAX_CANDLES = 2000;

/* ================= TENANTS ================= */

const TENANTS = new Map();
const DIRTY = new Set();

/* ================= UTIL ================= */

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function simulate(price,vol){

  const drift = (Math.random()-0.5) * vol;
  const trend = (Math.random()-0.5) * vol * 0.3;

  const next =
    price * (1 + drift + trend);

  return Number(
    clamp(next,0.0000001,1e12).toFixed(8)
  );
}

/* ================= LOAD ================= */

function loadState(tenantId){

  const file = stateFile(tenantId);

  if(!fs.existsSync(file))
    return null;

  try{

    return JSON.parse(
      fs.readFileSync(file,"utf-8")
    );

  }catch{

    console.warn(
      "marketEngine corrupted state reset:",
      tenantId
    );

    return null;
  }

}

/* ================= SAVE ================= */

function saveState(tenantId,state){

  try{

    const file = stateFile(tenantId);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(tmp,JSON.stringify(state));
    fs.renameSync(tmp,file);

  }catch(err){

    console.warn(
      "marketEngine save failed:",
      err.message
    );

  }

}

/* ================= REGISTER ================= */

function registerTenant(tenantId){

  if(!tenantId) return;

  if(TENANTS.has(tenantId))
    return;

  const persisted = loadState(tenantId);

  if(persisted){

    TENANTS.set(tenantId,persisted);
    return;

  }

  const state = {
    prices:{},
    candles:{}
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

  }

  TENANTS.set(tenantId,state);

}

/* ================= GET PRICE ================= */

function getPrice(tenantId,symbol){

  const state = TENANTS.get(tenantId);

  if(!state) return null;

  return state.prices?.[symbol] ?? null;

}

/* ================= CANDLE UPDATE ================= */

function updateCandle(state,symbol,price){

  if(!state.candles[symbol])
    state.candles[symbol] = [];

  const arr = state.candles[symbol];

  const now = Date.now();

  if(arr.length===0){

    arr.push({
      t:now,
      o:price,
      h:price,
      l:price,
      c:price
    });

    return;
  }

  const last = arr[arr.length-1];

  if(now-last.t >= CANDLE_MS){

    arr.push({
      t:now,
      o:price,
      h:price,
      l:price,
      c:price
    });

    if(arr.length > MAX_CANDLES)
      arr.splice(0,arr.length-MAX_CANDLES);

  }

  const cur = arr[arr.length-1];

  cur.h = Math.max(cur.h,price);
  cur.l = Math.min(cur.l,price);
  cur.c = price;

}

/* ================= MARKET TICK ================= */

function tickTenant(tenantId){

  const state = TENANTS.get(tenantId);

  if(!state) return;

  for(const sym of Object.keys(SYMBOLS)){

    const prev = state.prices[sym];

    const next =
      simulate(prev,SYMBOLS[sym].vol);

    state.prices[sym] = next;

    updateCandle(state,sym,next);

  }

  DIRTY.add(tenantId);

}

/* ================= AI LOOP ================= */

function runAI(tenantId){

  const state = TENANTS.get(tenantId);

  if(!state) return;

  for(const sym of Object.keys(state.prices)){

    const price = state.prices[sym];

    if(!price) continue;

    try{

      paperTrader.tick(
        tenantId,
        sym,
        price,
        Date.now()
      );

    }
    catch(err){

      console.error(
        "AI tick error:",
        err.message
      );

    }

  }

}

/* ================= SNAPSHOT ================= */

function getMarketSnapshot(tenantId){

  const state = TENANTS.get(tenantId);

  if(!state) return {};

  const out = {};

  for(const sym of Object.keys(state.prices))
    out[sym] = {price:state.prices[sym]};

  return out;

}

/* ================= CANDLES ================= */

function getCandles(tenantId,symbol,limit=200){

  const state = TENANTS.get(tenantId);

  if(!state)
    return [];

  if(!state.candles[symbol])
    return [];

  const arr = state.candles[symbol];

  return arr.slice(-limit).map(c=>({

    time:Math.floor(c.t/1000),
    open:c.o,
    high:c.h,
    low:c.l,
    close:c.c

  }));

}

/* ================= ENGINE LOOPS ================= */

setInterval(()=>{

  for(const tenantId of TENANTS.keys()){

    try{

      tickTenant(tenantId);

    }catch{}

  }

},MARKET_TICK_MS);

setInterval(()=>{

  for(const tenantId of DIRTY){

    const state = TENANTS.get(tenantId);

    if(state)
      saveState(tenantId,state);

  }

  DIRTY.clear();

},3000);

setInterval(()=>{

  for(const tenantId of TENANTS.keys()){

    try{

      runAI(tenantId);

    }catch{}

  }

},AI_TICK_MS);

/* ================= EXPORT ================= */

module.exports = {

  registerTenant,
  getMarketSnapshot,
  getCandles,
  getPrice

};
