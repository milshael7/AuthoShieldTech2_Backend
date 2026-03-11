// ==========================================================
// Kraken LIVE Trader — Execution Adapter
// Executes decisions coming from the AI brain
// ==========================================================

const crypto = require("crypto");

const KRAKEN_BASE = "https://api.kraken.com";

const API_KEY = String(process.env.KRAKEN_API_KEY || "").trim();
const API_SECRET = String(process.env.KRAKEN_API_SECRET || "").trim();

const LIVE_ENABLED =
  String(process.env.LIVE_TRADING_ENABLED || "false")
  .toLowerCase() === "true";

const LIVE_MAX_NOTIONAL_USD =
  Number(process.env.LIVE_MAX_NOTIONAL_USD || 25);

const LIVE_COOLDOWN_MS =
  Number(process.env.LIVE_COOLDOWN_MS || 30000);

/* ================= STATE ================= */

const state = {
  enabled: LIVE_ENABLED,
  lastOrderAt: 0,
  position: null,
  lastOrder: null,
  errors: []
};

/* ================= HELPERS ================= */

function ok(v){
  return v !== null && v !== undefined && v !== "";
}

function pushErr(e){
  const msg = String(e?.message || e);
  state.errors.push({ts:Date.now(),msg});
  if(state.errors.length > 50)
    state.errors = state.errors.slice(-50);
}

function krakenSign(urlPath, bodyStr, nonce){

  const secret =
    Buffer.from(API_SECRET,"base64");

  const hash =
    crypto.createHash("sha256")
      .update(String(nonce)+bodyStr)
      .digest();

  const hmac =
    crypto.createHmac("sha512",secret)
      .update(
        Buffer.concat([
          Buffer.from(urlPath),
          hash
        ])
      )
      .digest("base64");

  return hmac;
}

async function krakenPrivate(urlPath,params){

  const nonce = Date.now();

  const body =
    new URLSearchParams({
      nonce:String(nonce),
      ...params
    });

  const bodyStr = body.toString();

  const res = await fetch(
    KRAKEN_BASE+urlPath,
    {
      method:"POST",
      headers:{
        "Content-Type":
          "application/x-www-form-urlencoded",
        "API-Key":API_KEY,
        "API-Sign":
          krakenSign(urlPath,bodyStr,nonce)
      },
      body:bodyStr
    }
  );

  const json =
    await res.json();

  if(json.error?.length)
    throw new Error(json.error.join(","));

  return json.result;
}

/* ================= PAIR MAP ================= */

function toKrakenPair(symbol){

  const s =
    String(symbol)
      .toUpperCase()
      .replace(/[^A-Z]/g,"");

  if(s==="BTCUSDT") return "XBTUSD";
  if(s==="ETHUSDT") return "ETHUSD";

  return s;
}

/* ================= POSITION SIZE ================= */

function calcVolume(price,notional){

  const p = Number(price);
  const n = Number(notional);

  if(!(p>0 && n>0)) return 0;

  return n/p;
}

/* ================= ORDER ================= */

async function placeOrder({
  symbol,
  side,
  price,
  notionalUSD
}){

  const pair = toKrakenPair(symbol);

  const now = Date.now();

  if(!state.enabled)
    return {ok:false,reason:"disabled"};

  if(now - state.lastOrderAt < LIVE_COOLDOWN_MS)
    return {ok:false,reason:"cooldown"};

  const notional =
    Math.min(notionalUSD,
      LIVE_MAX_NOTIONAL_USD);

  const volume =
    calcVolume(price,notional);

  if(!(volume>0))
    return {ok:false,reason:"size"};

  const params = {

    pair,
    type:side.toLowerCase(),
    ordertype:"market",
    volume:volume.toFixed(6)

  };

  const result =
    await krakenPrivate(
      "/0/private/AddOrder",
      params
    );

  state.lastOrderAt = now;

  state.lastOrder = {
    pair,
    side,
    volume,
    txid:result.txid?.[0]
  };

  return {
    ok:true,
    result:state.lastOrder
  };
}

/* ================= EXECUTION ================= */

async function evaluateAndTrade(snapshot){

  try{

    const decision =
      String(snapshot.decision || "WAIT")
      .toUpperCase();

    const symbol =
      String(snapshot.symbol || "");

    const price =
      Number(snapshot.price);

    if(decision==="WAIT")
      return {ok:true,skipped:true};

    if(!(price>0))
      return {ok:false};

    const pair =
      toKrakenPair(symbol);

    /* CLOSE LOGIC */

    if(
      state.position &&
      state.position.pair===pair &&
      (
        (state.position.side==="buy" && decision==="SELL") ||
        (state.position.side==="sell" && decision==="BUY")
      )
    ){

      const close =
        await placeOrder({
          symbol,
          side:
            state.position.side==="buy"
            ? "sell"
            : "buy",
          price,
          notionalUSD:
            snapshot.notionalUSD
        });

      state.position = null;

      return close;
    }

    /* OPEN POSITION */

    if(!state.position){

      const order =
        await placeOrder({
          symbol,
          side:
            decision==="BUY"
            ? "buy"
            : "sell",
          price,
          notionalUSD:
            snapshot.notionalUSD
        });

      if(order.ok){

        state.position={
          pair,
          side:
            decision==="BUY"
            ? "buy"
            : "sell",
          openedAt:Date.now()
        };

      }

      return order;

    }

    return {
      ok:true,
      skipped:true,
      reason:"position locked"
    };

  }
  catch(e){

    pushErr(e);

    return {
      ok:false,
      error:String(e.message)
    };

  }

}

/* ================= STATUS ================= */

function getStatus(){

  return{

    ok:true,
    enabled:state.enabled,
    lastOrder:state.lastOrder,
    position:state.position,
    recentErrors:state.errors.slice(-10)

  };

}

module.exports={
  evaluateAndTrade,
  placeOrder,
  getStatus
};
