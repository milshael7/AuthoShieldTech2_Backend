// --------------------------------------------------
// AutoShield — Market Engine (Institutional Stable v2)
// Deterministic • Multi-Tenant • Time-Safe • AI-Ready
// --------------------------------------------------

const WebSocket = require("ws");

const paperTrader = require("./paperTrader");
const liveTrader = require("./liveTrader");

/* ================= CONFIG ================= */

const CONFIG = {
  tickMs: 1000,
  candleSeconds: 60,
  maxCandles: 2000,
  defaultSymbols: ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"],
  maxTickMove: 0.20, // 20% safety cap per tick
};

/* ================= STATE ================= */

const TENANTS = new Map();
let exchangeConnected = false;

const GLOBAL_PRICE = {
  BTCUSDT: 65000,
  ETHUSDT: 3500,
};

/* ================= HELPERS ================= */

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function nowSeconds(){
  return Math.floor(Date.now()/1000);
}

function seedFrom(tenantId,symbol){
  const s = `${tenantId}:${symbol}`;
  let h = 2166136261;
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h,16777619);
  }
  return h>>>0;
}

function xorshift32(seed){
  let x = seed|0;
  return ()=>{
    x ^= x<<13;
    x ^= x>>>17;
    x ^= x<<5;
    return (x>>>0)/4294967296;
  };
}

function basePrice(symbol){
  switch(symbol){
    case "BTCUSDT": return GLOBAL_PRICE.BTCUSDT;
    case "ETHUSDT": return GLOBAL_PRICE.ETHUSDT;
    case "SOLUSDT": return 150;
    case "XRPUSDT": return 0.6;
    default: return 100;
  }
}

/* ================= EXCHANGE FEED ================= */

function startKrakenFeed(){
  try{
    const ws = new WebSocket("wss://ws.kraken.com");

    ws.on("open",()=>{
      exchangeConnected = true;
      ws.send(JSON.stringify({
        event:"subscribe",
        pair:["XBT/USD","ETH/USD"],
        subscription:{ name:"ticker" }
      }));
    });

    ws.on("message",(msg)=>{
      try{
        const data = JSON.parse(msg);

        if(Array.isArray(data) && data[1]){
          const price = Number(data[1].c?.[0]);
          const pair = data[3];

          if(Number.isFinite(price) && price > 0){

            if(pair==="XBT/USD")
              GLOBAL_PRICE.BTCUSDT = price;

            if(pair==="ETH/USD")
              GLOBAL_PRICE.ETHUSDT = price;
          }
        }
      }catch{}
    });

    ws.on("close",()=>{
      exchangeConnected = false;
      setTimeout(startKrakenFeed,5000);
    });

  }catch{}
}

startKrakenFeed();

/* ================= TENANT INIT ================= */

function getTenant(tenantId){

  if(!TENANTS.has(tenantId)){

    const market = {
      prices:{},
      candles:{},
    };

    for(const sym of CONFIG.defaultSymbols){

      const rnd = xorshift32(seedFrom(tenantId,sym));
      const price = basePrice(sym);
      const t = nowSeconds();

      market.prices[sym] = { price, rnd };

      market.candles[sym] = [{
        t,
        o: price,
        h: price,
        l: price,
        c: price
      }];
    }

    TENANTS.set(tenantId,market);
  }

  return TENANTS.get(tenantId);
}

/* ================= CANDLE ENGINE ================= */

function updateCandle(arr,price){
  const c = arr[arr.length-1];
  c.h = Math.max(c.h,price);
  c.l = Math.min(c.l,price);
  c.c = price;
}

function maybeRollCandle(arr){

  const currentTime = nowSeconds();
  const last = arr[arr.length-1];

  if(currentTime - last.t >= CONFIG.candleSeconds){

    arr.push({
      t: currentTime,
      o: last.c,
      h: last.c,
      l: last.c,
      c: last.c
    });

    if(arr.length > CONFIG.maxCandles){
      arr.splice(0,arr.length-CONFIG.maxCandles);
    }
  }
}

/* ================= MARKET TICK ================= */

function marketTick(tenantId){

  const market = getTenant(tenantId);

  for(const sym of Object.keys(market.prices)){

    const node = market.prices[sym];
    let rawPrice;

    /* ===== Exchange or Simulation ===== */

    if(exchangeConnected && GLOBAL_PRICE[sym]){
      rawPrice = GLOBAL_PRICE[sym];
    } else {

      const rnd = node.rnd();

      const volatilityBase =
        sym==="BTCUSDT"?0.0025:
        sym==="ETHUSDT"?0.0035:
        sym==="SOLUSDT"?0.006:
        sym==="XRPUSDT"?0.01:0.004;

      const drift = (rnd-0.5)*2*volatilityBase;
      rawPrice = node.price*(1+drift);
    }

    /* ===== Safety Guards ===== */

    if(!Number.isFinite(rawPrice) || rawPrice <= 0){
      rawPrice = node.price;
    }

    const upper = node.price*(1+CONFIG.maxTickMove);
    const lower = node.price*(1-CONFIG.maxTickMove);

    if(rawPrice > upper || rawPrice < lower){
      rawPrice = node.price;
    }

    const nextPrice = clamp(rawPrice,0.0001,1000000);

    node.price = Number(nextPrice.toFixed(8));

    const candles = market.candles[sym];

    maybeRollCandle(candles);
    updateCandle(candles,node.price);

    /* ===== Feed Trading Engines ===== */

    try{ paperTrader.tick(tenantId,sym,node.price); }catch{}
    try{ liveTrader.tick(tenantId,sym,node.price); }catch{}
  }
}

/* ================= LOOP ================= */

setInterval(()=>{
  for(const tenantId of TENANTS.keys()){
    try{ marketTick(tenantId); }catch{}
  }
},CONFIG.tickMs);

/* ================= API ================= */

function registerTenant(tenantId){
  getTenant(tenantId);
}

function getPrice(tenantId,symbol){
  const market = getTenant(tenantId);
  return market.prices[symbol]?.price || null;
}

function getCandles(tenantId,symbol,limit=200){

  const market = getTenant(tenantId);
  const arr = market.candles[symbol] || [];

  return arr
    .slice(-limit)
    .map(c=>({
      time: c.t, // already seconds
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    );
}

function getMarketSnapshot(tenantId){

  const market = getTenant(tenantId);
  const snapshot = {};

  for(const sym of Object.keys(market.prices)){
    snapshot[sym] = {
      price: market.prices[sym].price
    };
  }

  return snapshot;
}

module.exports = {
  registerTenant,
  getPrice,
  getCandles,
  getMarketSnapshot
};
