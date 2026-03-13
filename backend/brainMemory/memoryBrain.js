// ==========================================================
// AUTOSHIELD MEMORY BRAIN — PERMANENT MEMORY CORE v2
// Optimized: safe persistence + batched writes
// ==========================================================

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const BASE_PATH =
  process.env.MEMORY_BRAIN_DIR ||
  process.env.RENDER_DISK_PATH ||
  path.join(process.cwd(),"brainMemory","store");

const MAX_TRADES = 100000;
const MAX_SIGNALS = 100000;
const MAX_MARKET_STATES = 100000;

/* Save every 5 seconds */
const SAVE_INTERVAL = 5000;

/* ================= HELPERS ================= */

function ensureDir(p){
  if(!fs.existsSync(p))
    fs.mkdirSync(p,{recursive:true});
}

function memoryPath(tenantId){
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH,`memory_${tenantId}.json`);
}

/* ================= DEFAULT MEMORY ================= */

function defaultMemory(){

  return{

    version:2,

    createdAt:Date.now(),
    updatedAt:Date.now(),

    stats:{
      totalTrades:0,
      wins:0,
      losses:0,
      totalSignals:0
    },

    trades:[],
    signals:[],
    marketStates:[]

  };

}

/* ================= CACHE ================= */

const MEMORY = new Map();
const DIRTY = new Set();

/* ================= LOAD ================= */

function load(tenantId){

  if(MEMORY.has(tenantId))
    return MEMORY.get(tenantId);

  let mem = defaultMemory();

  const file = memoryPath(tenantId);

  try{

    if(fs.existsSync(file)){

      const raw =
        JSON.parse(fs.readFileSync(file,"utf-8"));

      mem = {...mem,...raw};

    }

  }catch(err){

    console.error("Memory load error:",err.message);

  }

  MEMORY.set(tenantId,mem);

  return mem;

}

/* ================= SAVE ================= */

function save(tenantId){

  try{

    const mem = MEMORY.get(tenantId);
    if(!mem) return;

    mem.updatedAt = Date.now();

    const file = memoryPath(tenantId);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(mem,null,2)
    );

    fs.renameSync(tmp,file);

  }catch(err){

    console.error("Memory save error:",err.message);

  }

}

/* ================= BATCHED SAVE LOOP ================= */

setInterval(()=>{

  for(const tenantId of DIRTY){

    save(tenantId);

  }

  DIRTY.clear();

},SAVE_INTERVAL);

/* ================= RECORD TRADE ================= */

function recordTrade({
  tenantId,
  symbol,
  entry,
  exit,
  qty,
  pnl,
  risk,
  confidence,
  edge,
  volatility
}){

  const mem = load(tenantId);

  const trade = {
    ts:Date.now(),
    symbol,
    entry,
    exit,
    qty,
    pnl,
    risk,
    confidence,
    edge,
    volatility
  };

  mem.trades.push(trade);

  if(mem.trades.length > MAX_TRADES)
    mem.trades = mem.trades.slice(-MAX_TRADES);

  mem.stats.totalTrades++;

  if(pnl > 0)
    mem.stats.wins++;
  else
    mem.stats.losses++;

  DIRTY.add(tenantId);

}

/* ================= RECORD SIGNAL ================= */

function recordSignal({
  tenantId,
  symbol,
  action,
  confidence,
  edge,
  price,
  volatility
}){

  const mem = load(tenantId);

  const signal = {
    ts:Date.now(),
    symbol,
    action,
    confidence,
    edge,
    price,
    volatility
  };

  mem.signals.push(signal);

  if(mem.signals.length > MAX_SIGNALS)
    mem.signals = mem.signals.slice(-MAX_SIGNALS);

  mem.stats.totalSignals++;

  DIRTY.add(tenantId);

}

/* ================= RECORD MARKET STATE ================= */

function recordMarketState({
  tenantId,
  symbol,
  price,
  volatility
}){

  const mem = load(tenantId);

  const state = {
    ts:Date.now(),
    symbol,
    price,
    volatility
  };

  mem.marketStates.push(state);

  if(mem.marketStates.length > MAX_MARKET_STATES)
    mem.marketStates =
      mem.marketStates.slice(-MAX_MARKET_STATES);

  DIRTY.add(tenantId);

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId){

  const mem = load(tenantId);

  return{

    stats:mem.stats,

    tradesStored:mem.trades.length,
    signalsStored:mem.signals.length,
    marketStatesStored:mem.marketStates.length

  };

}

/* ================= EXPORT ================= */

module.exports = {

  load,
  recordTrade,
  recordSignal,
  recordMarketState,
  snapshot

};
