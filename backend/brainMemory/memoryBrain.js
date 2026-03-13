// ==========================================================
// AUTOSHIELD MEMORY BRAIN — PERMANENT MEMORY CORE v3
// FIXED: Render-safe storage path + atomic saves + fast restore
// ==========================================================

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const MAX_TRADES = 100000;
const MAX_SIGNALS = 100000;
const MAX_MARKET_STATES = 100000;

const SAVE_INTERVAL = 5000;

/* ================= PATH RESOLUTION ================= */

let ACTIVE_BASE_PATH = null;

function ensureDir(p){
  try{
    if(!fs.existsSync(p)){
      fs.mkdirSync(p,{recursive:true});
    }
    return true;
  }catch{
    return false;
  }
}

function canWriteDir(p){
  try{
    if(!ensureDir(p)) return false;

    const probe = path.join(p, `.probe_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);

    return true;
  }catch{
    return false;
  }
}

function resolveBasePath(){

  if(ACTIVE_BASE_PATH)
    return ACTIVE_BASE_PATH;

  const candidates = [];

  if(process.env.MEMORY_BRAIN_DIR)
    candidates.push(process.env.MEMORY_BRAIN_DIR);

  if(process.env.RENDER_DISK_PATH)
    candidates.push(path.join(process.env.RENDER_DISK_PATH, "brain"));

  candidates.push("/tmp/brain");
  candidates.push(path.join(process.cwd(), "brainMemory", "store"));

  for(const p of candidates){
    if(canWriteDir(p)){
      ACTIVE_BASE_PATH = p;
      console.log(`[MEMORY] using store: ${ACTIVE_BASE_PATH}`);
      return ACTIVE_BASE_PATH;
    }
  }

  throw new Error("No writable memory brain directory found");

}

function memoryPath(tenantId){
  const base = resolveBasePath();
  return path.join(base, `memory_${tenantId}.json`);
}

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ================= DEFAULT MEMORY ================= */

function defaultMemory(){

  return{
    version:3,

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

  const key = tenantId || "__default__";

  if(MEMORY.has(key))
    return MEMORY.get(key);

  let mem = defaultMemory();

  try{

    const file = memoryPath(key);

    if(fs.existsSync(file)){

      const raw =
        JSON.parse(fs.readFileSync(file,"utf-8"));

      mem = {
        ...mem,
        ...raw,
        stats:{
          ...mem.stats,
          ...(raw?.stats || {})
        }
      };

    }

  }catch(err){

    console.error("Memory load error:",err.message);

  }

  MEMORY.set(key,mem);

  return mem;

}

/* ================= SAVE ================= */

function save(tenantId){

  const key = tenantId || "__default__";

  try{

    const mem = MEMORY.get(key);
    if(!mem) return;

    mem.updatedAt = Date.now();

    const file = memoryPath(key);
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

  const key = tenantId || "__default__";
  const mem = load(key);

  const trade = {
    ts:Date.now(),
    symbol,
    entry:safeNum(entry),
    exit:safeNum(exit),
    qty:safeNum(qty),
    pnl:safeNum(pnl),
    risk:safeNum(risk),
    confidence:safeNum(confidence),
    edge:safeNum(edge),
    volatility:safeNum(volatility)
  };

  mem.trades.push(trade);

  if(mem.trades.length > MAX_TRADES)
    mem.trades = mem.trades.slice(-MAX_TRADES);

  mem.stats.totalTrades++;

  if(trade.pnl > 0)
    mem.stats.wins++;
  else if(trade.pnl < 0)
    mem.stats.losses++;

  DIRTY.add(key);

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

  const key = tenantId || "__default__";
  const mem = load(key);

  const signal = {
    ts:Date.now(),
    symbol,
    action,
    confidence:safeNum(confidence),
    edge:safeNum(edge),
    price:safeNum(price),
    volatility:safeNum(volatility)
  };

  mem.signals.push(signal);

  if(mem.signals.length > MAX_SIGNALS)
    mem.signals = mem.signals.slice(-MAX_SIGNALS);

  mem.stats.totalSignals++;

  DIRTY.add(key);

}

/* ================= RECORD MARKET STATE ================= */

function recordMarketState({
  tenantId,
  symbol,
  price,
  volatility
}){

  const key = tenantId || "__default__";
  const mem = load(key);

  const state = {
    ts:Date.now(),
    symbol,
    price:safeNum(price),
    volatility:safeNum(volatility)
  };

  mem.marketStates.push(state);

  if(mem.marketStates.length > MAX_MARKET_STATES)
    mem.marketStates =
      mem.marketStates.slice(-MAX_MARKET_STATES);

  DIRTY.add(key);

}

/* ================= FAST RESTORE ================= */

function restoreTenant(tenantId){

  const key = tenantId || "__default__";
  const mem = load(key);

  return {
    stats:mem.stats,
    recentTrades:mem.trades.slice(-50),
    recentSignals:mem.signals.slice(-100),
    recentMarketStates:mem.marketStates.slice(-500)
  };

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId){

  const key = tenantId || "__default__";
  const mem = load(key);

  return{
    stats:mem.stats,
    tradesStored:mem.trades.length,
    signalsStored:mem.signals.length,
    marketStatesStored:mem.marketStates.length,
    storagePath:ACTIVE_BASE_PATH || resolveBasePath()
  };

}

/* ================= EXPORT ================= */

module.exports = {
  load,
  recordTrade,
  recordSignal,
  recordMarketState,
  restoreTenant,
  snapshot
};
