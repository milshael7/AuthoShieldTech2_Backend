// ==========================================================
// Market Replay Engine
// Feeds historical candles to the AI
// ==========================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR =
  process.env.MARKET_DATA_DIR ||
  path.join(process.cwd(), "backend/data/market_data");

function loadMarketData(symbol = "BTCUSDT") {

  try {

    const file = path.join(DATA_DIR, `${symbol}.json`);

    if (!fs.existsSync(file)) {
      return [];
    }

    const raw = fs.readFileSync(file, "utf8");

    return JSON.parse(raw);

  } catch (err) {

    console.error("Replay load error:", err);

    return [];

  }

}

function replayCandles({
  symbol = "BTCUSDT",
  limit = 1000,
}) {

  const candles = loadMarketData(symbol);

  if (!candles.length) return [];

  return candles.slice(-limit);

}

module.exports = {
  loadMarketData,
  replayCandles,
};
