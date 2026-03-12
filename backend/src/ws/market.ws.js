// ==========================================================
// MARKET WEBSOCKET ENGINE
// Feeds price ticks to frontend + AI trading engine
// FIXED: correct payload format + tenant feed
// ==========================================================

const paperTrader = require("../services/paperTrader");

const SYMBOL = "BTCUSDT";

let price = 65000;

function nextPrice(){

  const move =
    (Math.random() - 0.5) * price * 0.0015;

  price += move;

  return price;

}

function startMarketStream(wss){

  setInterval(()=>{

    const newPrice = nextPrice();

    const payload = {

      channel:"market",
      type:"snapshot",

      data:{
        [SYMBOL]:{
          price:newPrice
        }
      }

    };

    /* BROADCAST TO CLIENTS */

    wss.clients.forEach(client=>{

      if(client.readyState === 1){

        try{
          client.send(JSON.stringify(payload));
        }catch{}

      }

    });

    /* FEED AI */

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

  },1000);

}

module.exports = {
  startMarketStream
};
