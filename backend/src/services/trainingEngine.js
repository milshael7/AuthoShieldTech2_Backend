// ==========================================================
// AI Training Engine
// Runs historical simulations for strategy learning
// ==========================================================

const replayEngine = require("./marketReplayEngine");
const aiBrain = require("./aiBrain");

async function runTrainingSession({
  tenantId,
  symbol = "BTCUSDT",
  candles = [],
}) {

  if (!candles || !candles.length) {
    return { ok: false, error: "No candles provided" };
  }

  let trades = 0;

  for (const candle of candles) {

    const price = Number(candle.close);

    if (!Number.isFinite(price)) continue;

    const decision = aiBrain.decide?.({
      tenantId,
      symbol,
      last: price,
      paper: {},
    });

    if (!decision) continue;

    if (decision.action === "BUY" || decision.action === "SELL") {
      trades++;
    }

  }

  return {
    ok: true,
    symbol,
    candlesProcessed: candles.length,
    tradesSimulated: trades,
  };

}

module.exports = {
  runTrainingSession,
};
