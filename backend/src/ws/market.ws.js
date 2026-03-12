// ==========================================================
// MARKET WEBSOCKET ENGINE
// Feeds price ticks to frontend + AI trading engine
// FIXED: multi-tenant AI feed
// ==========================================================

const paperTrader = require("../services/paperTrader");
const marketEngine = require("../services/marketEngine");

const SYMBOL = "BTCUSDT";

let price = 65000;

/* =========================================================
   PRICE SIMULATION ENGINE
========================================================= */

function nextPrice(){

  const move =
    (Math.random() - 0.5) * price * 0.0015;

  price += move;

  return price;

}

/* =========================================================
   START MARKET STREAM
========================================================= */

function startMarketStream(wss){

  setInterval(()=>{

    const newPrice = nextPrice();

    const payload = {

      type:"market",

      data:{
        [SYMBOL]:{
          price:newPrice
        }
      }

    };

    /* ================= BROADCAST ================= */

    wss.clients.forEach(client=>{

      if(client.readyState === 1){

        try{
          client.send(JSON.stringify(payload));
        }catch{}

      }

    });

    /* ================= FEED AI ================= */

    try{

      // send tick to every tenant connected
      const tenants = new Set();

      wss.clients.forEach(ws=>{
        if(ws.tenantId){
          tenants.add(ws.tenantId);
        }
      });

      tenants.forEach(tenantId=>{

        try{

          paperTrader.tick(
            tenantId,
            SYMBOL,
            newPrice
          );

        }catch{}

      });

    }catch{}

  },1000);

}

module.exports = {
  startMarketStream
};
