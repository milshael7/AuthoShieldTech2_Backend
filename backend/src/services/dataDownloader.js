// backend/src/services/dataDownloader.js
// ==========================================================
// Binance Historical Data Downloader
// Saves candles for AI training
// ==========================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR =
  process.env.MARKET_DATA_DIR ||
  path.join(__dirname,"../../data/market_data");

async function downloadBTC() {

  const url =
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000";

  const res = await fetch(url);

  const data = await res.json();

  const candles = data.map(c => ({
    time: Number(c[0]),
    close: Number(c[4])
  }));

  if (!fs.existsSync(DATA_DIR))
    fs.mkdirSync(DATA_DIR,{recursive:true});

  const file =
    path.join(DATA_DIR,"BTCUSDT.json");

  fs.writeFileSync(
    file,
    JSON.stringify(candles,null,2)
  );

  return {
    candles: candles.length
  };

}

module.exports = {
  downloadBTC
};
