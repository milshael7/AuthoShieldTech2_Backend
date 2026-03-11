// backend/src/services/krakenLiveTrader.js
// ==========================================================
// Kraken LIVE Trader (Executor)
// - Executes real Kraken orders from your existing decision engine
// - This is NOT the brain; it only follows BUY / SELL / WAIT
// - Includes safety gates, cooldowns, hard notional caps
// - Includes startup + interval position sync from Kraken
// ==========================================================

const crypto = require("crypto");

const KRAKEN_BASE = "https://api.kraken.com";

const API_KEY = String(process.env.KRAKEN_API_KEY || "").trim();
const API_SECRET = String(process.env.KRAKEN_API_SECRET || "").trim();

const LIVE_ENABLED =
  String(process.env.LIVE_TRADING_ENABLED || "false")
    .trim()
    .toLowerCase() === "true";

const LIVE_MAX_NOTIONAL_USD =
  Number(process.env.LIVE_MAX_NOTIONAL_USD || 25);

const LIVE_COOLDOWN_MS =
  Number(process.env.LIVE_COOLDOWN_MS || 30000);

/* ================= STATE ================= */

const state = {
  enabled: LIVE_ENABLED,
  lastOrderAt: 0,
  position: null, // { pair, side, vol, avgPrice, openedAt, synced }
  lastOrder: null,
  errors: []
};

/* ================= HELPERS ================= */

function ok(v){
  return v !== null && v !== undefined && v !== "";
}

function pushErr(e){
  const msg = String(e?.message || e || "error");
  state.errors.push({ ts: Date.now(), msg });
  if(state.errors.length > 50){
    state.errors = state.errors.slice(-50);
  }
}

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

/* ================= KRAKEN SIGNING ================= */

function krakenSign(urlPath, bodyStr, nonce){

  const secret = Buffer.from(API_SECRET, "base64");

  const hash = crypto
    .createHash("sha256")
    .update(String(nonce) + bodyStr)
    .digest();

  const sig = crypto
    .createHmac("sha512", secret)
    .update(Buffer.concat([
      Buffer.from(urlPath),
      hash
    ]))
    .digest("base64");

  return sig;
}

async function krakenPrivate(urlPath, paramsObj = {}){

  if(!ok(API_KEY) || !ok(API_SECRET)){
    throw new Error("Missing KRAKEN_API_KEY or KRAKEN_API_SECRET");
  }

  const nonce = Date.now();

  const body = new URLSearchParams({
    nonce: String(nonce),
    ...paramsObj
  });

  const bodyStr = body.toString();

  const res = await fetch(KRAKEN_BASE + urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key": API_KEY,
      "API-Sign": krakenSign(urlPath, bodyStr, nonce)
    },
    body: bodyStr
  });

  const json = await res.json().catch(() => null);

  if(!res.ok){
    throw new Error(`Kraken HTTP ${res.status}: ${JSON.stringify(json || {})}`);
  }

  if(!json){
    throw new Error("Kraken: empty response");
  }

  if(Array.isArray(json.error) && json.error.length){
    throw new Error(`Kraken error: ${json.error.join(", ")}`);
  }

  return json.result;
}

async function krakenPublic(path){
  const res = await fetch(KRAKEN_BASE + path);
  const json = await res.json().catch(() => null);

  if(!res.ok){
    throw new Error(`Kraken public HTTP ${res.status}`);
  }

  if(!json){
    throw new Error("Kraken public: empty response");
  }

  if(Array.isArray(json.error) && json.error.length){
    throw new Error(`Kraken public error: ${json.error.join(", ")}`);
  }

  return json.result;
}

/* ================= PAIR MAP ================= */

function toKrakenPair(symbol){

  const s = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if(s === "BTCUSD" || s === "XBTUSD") return "XBTUSD";
  if(s === "ETHUSD") return "ETHUSD";
  if(s === "BTCUSDT") return "XBTUSD";
  if(s === "ETHUSDT") return "ETHUSD";

  return s;
}

/* ================= STATUS ================= */

function getStatus(){
  return {
    ok: true,
    enabled: state.enabled,
    liveEnvEnabled: LIVE_ENABLED,
    cooldownMs: LIVE_COOLDOWN_MS,
    lastOrderAt: state.lastOrderAt || null,
    hasKeys: ok(API_KEY) && ok(API_SECRET),
    position: state.position,
    lastOrder: state.lastOrder,
    recentErrors: state.errors.slice(-10)
  };
}

function setEnabled(on){
  state.enabled = !!on;
}

function clearPosition(){
  state.position = null;
}

/* ================= RISK / SIZE ================= */

function calcVolumeFromNotionalUSD(pair, notionalUSD, price){

  const p = Number(price);
  const n = Number(notionalUSD);

  if(!Number.isFinite(p) || p <= 0) return 0;
  if(!Number.isFinite(n) || n <= 0) return 0;

  const vol = n / p;

  return clamp(vol, 0, 1e12);
}

/* ================= ORDER PLACEMENT ================= */

async function placeOrder({
  symbol,
  side,
  price,
  notionalUSD,
  type = "market",
  limitPrice = null
}){

  const pair = toKrakenPair(symbol);
  const now = Date.now();

  if(!state.enabled){
    return { ok:false, skipped:true, reason:"live disabled (state)" };
  }

  if(!LIVE_ENABLED){
    return { ok:false, skipped:true, reason:"LIVE_TRADING_ENABLED is false (env)" };
  }

  if(now - state.lastOrderAt < LIVE_COOLDOWN_MS){
    return { ok:false, skipped:true, reason:"cooldown" };
  }

  const useNotional =
    Math.min(Number(notionalUSD || 0), LIVE_MAX_NOTIONAL_USD);

  if(!(useNotional > 0)){
    return { ok:false, skipped:true, reason:"notional <= 0" };
  }

  const vol = calcVolumeFromNotionalUSD(pair, useNotional, price);

  if(!(vol > 0)){
    return { ok:false, skipped:true, reason:"volume <= 0" };
  }

  const orderType =
    String(type).toLowerCase() === "limit" ? "limit" : "market";

  const krSide =
    String(side).toLowerCase() === "sell" ? "sell" : "buy";

  const params = {
    pair,
    type: krSide,
    ordertype: orderType,
    volume: vol.toFixed(6)
  };

  if(orderType === "limit"){
    const lp = Number(limitPrice);
    if(!Number.isFinite(lp) || lp <= 0){
      return { ok:false, skipped:true, reason:"missing limitPrice" };
    }
    params.price = lp.toFixed(2);
  }

  const result = await krakenPrivate("/0/private/AddOrder", params);

  state.lastOrderAt = now;

  state.lastOrder = {
    ts: now,
    pair,
    side: krSide,
    orderType,
    volume: params.volume,
    notionalUSD: useNotional,
    txid: result?.txid?.[0] || null,
    descr: result?.descr || null
  };

  return { ok:true, result: state.lastOrder };
}

/* ================= POSITION SYNC ================= */

async function syncPosition(){

  try{

    if(!ok(API_KEY) || !ok(API_SECRET)){
      return { ok:false, skipped:true, reason:"missing api keys" };
    }

    // Prefer open positions if available on account
    let openPositions = null;
    try{
      openPositions = await krakenPrivate("/0/private/OpenPositions", {
        docalcs: true
      });
    }catch(e){
      // Some accounts / permission sets may not support this exactly
      pushErr(e);
    }

    if(openPositions && typeof openPositions === "object"){
      const ids = Object.keys(openPositions);

      if(ids.length){
        const pos = openPositions[ids[0]];

        state.position = {
          pair: pos.pair || null,
          side:
            Number(pos.vol || 0) >= 0 ? "buy" : "sell",
          vol: Math.abs(Number(pos.vol || 0)),
          avgPrice: Number(pos.cost && pos.vol ? Number(pos.cost) / Math.abs(Number(pos.vol)) : pos.avg_price || 0) || null,
          openedAt: Date.now(),
          synced: true
        };

        return { ok:true, synced:true, source:"OpenPositions", position: state.position };
      }
    }

    // Fallback to open orders view
    let openOrders = null;
    try{
      openOrders = await krakenPrivate("/0/private/OpenOrders", {});
    }catch(e){
      pushErr(e);
    }

    const orders = openOrders?.open || {};
    const ids = Object.keys(orders);

    if(!ids.length){
      state.position = null;
      return { ok:true, synced:true, position:null };
    }

    const order = orders[ids[0]];

    state.position = {
      pair: order?.descr?.pair || null,
      side: order?.descr?.type || null,
      vol: Number(order?.vol || 0) || 0,
      avgPrice: Number(order?.descr?.price || 0) || null,
      openedAt: Date.now(),
      synced: true
    };

    return { ok:true, synced:true, source:"OpenOrders", position: state.position };

  }catch(e){

    pushErr(e);

    return {
      ok:false,
      error:String(e?.message || e)
    };
  }
}

/* ================= DECISION EXECUTION ================= */

async function evaluateAndTrade(snapshot){

  try{

    const s = snapshot || {};

    const decision =
      String(s.decision || "WAIT").toUpperCase();

    const symbol =
      String(s.symbol || "").trim();

    const price =
      Number(s.price);

    if(!ok(symbol) || !Number.isFinite(price)){
      return { ok:false, skipped:true, reason:"missing symbol/price" };
    }

    if(s.halted){
      return { ok:true, skipped:true, reason:"halted by safety" };
    }

    if(decision !== "BUY" && decision !== "SELL"){
      return { ok:true, skipped:true, reason:"decision WAIT/UNKNOWN" };
    }

    if(s.approved === false){
      return { ok:true, skipped:true, reason:"brain did not approve" };
    }

    const pair = toKrakenPair(symbol);
    const desiredSide = decision === "BUY" ? "buy" : "sell";

    // If synced position exists and same direction, do nothing
    if(state.position && state.position.pair === pair && state.position.side === desiredSide){
      return { ok:true, skipped:true, reason:"position already open in same direction" };
    }

    // If opposite position exists, close / flip
    if(state.position && state.position.pair === pair && state.position.side !== desiredSide){

      const closeOut = await placeOrder({
        symbol,
        side: state.position.side === "buy" ? "sell" : "buy",
        price,
        notionalUSD: Number(s.notionalUSD || LIVE_MAX_NOTIONAL_USD),
        type: s.orderType || "market",
        limitPrice: s.limitPrice || null
      });

      if(!closeOut.ok){
        return closeOut;
      }

      state.position = null;

      // small pause before flip
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    const out = await placeOrder({
      symbol,
      side: desiredSide,
      price,
      notionalUSD: Number(s.notionalUSD || 0),
      type: s.orderType || "market",
      limitPrice: s.limitPrice || null
    });

    if(out.ok){
      state.position = {
        pair,
        side: desiredSide,
        vol: Number(out?.result?.volume || 0) || null,
        avgPrice: Number(price) || null,
        openedAt: Date.now(),
        synced: false
      };
    }

    return out;

  }catch(e){

    pushErr(e);

    return {
      ok:false,
      error:String(e?.message || e)
    };
  }
}

/* ================= STARTUP SYNC ================= */

(async()=>{
  try{
    if(ok(API_KEY) && ok(API_SECRET)){
      await syncPosition();
    }
  }catch(e){
    pushErr(e);
  }
})();

/* ================= BACKGROUND SYNC ================= */

setInterval(()=>{
  if(!LIVE_ENABLED) return;
  syncPosition().catch(pushErr);
}, 30000);

/* ================= EXPORT ================= */

module.exports = {
  getStatus,
  setEnabled,
  clearPosition,
  syncPosition,
  evaluateAndTrade,
  placeOrder
};
