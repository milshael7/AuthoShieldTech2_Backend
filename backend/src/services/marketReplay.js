// backend/src/services/marketReplay.js
// ==========================================================
// Historical Market Replay Engine
// Replays real market candles for AI training
// ==========================================================

const fs = require("fs");
const path = require("path");

const paperTrader = require("./paperTrader");

/* ======================================================
DATA PATH
====================================================== */

const DATA_DIR =
  process.env.MARKET_DATA_DIR ||
  path.join("/tmp","market_data");

/* ======================================================
LOAD DATA
====================================================== */

function loadMarketData(symbol){

  const file =
    path.join(DATA_DIR,`${symbol}.json`);

  if(!fs.existsSync(file))
    throw new Error(
      `Market data missing for ${symbol}`
    );

  return JSON.parse(
    fs.readFileSync(file,"utf-8")
  );

}

/* ======================================================
REPLAY
====================================================== */

async function replayMarket({

  tenantId="replay",
  symbol="BTCUSDT",
  speed=1

}={}){

  const candles = loadMarketData(symbol);

  paperTrader.hardReset(tenantId);

  for(const candle of candles){

    const price = candle.close;

    paperTrader.tick(
      tenantId,
      symbol,
      price,
      candle.time
    );

  }

  return paperTrader.snapshot(tenantId);

}

module.exports={
  replayMarket
};
