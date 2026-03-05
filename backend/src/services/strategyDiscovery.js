// ==========================================================
// Strategy Discovery Engine
// Generates and tests new trading strategies
// ==========================================================

const trainingEngine = require("./trainingEngine");
const replayEngine = require("./marketReplayEngine");

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function generateStrategy() {

  return {
    confidenceThreshold: randomBetween(0.5, 0.8),
    edgeThreshold: randomBetween(0.001, 0.01),
    riskMultiplier: randomBetween(0.5, 2),
  };

}

async function discoverStrategy({
  tenantId,
  symbol = "BTCUSDT",
}) {

  const candles =
    replayEngine.replayCandles({ symbol });

  const strategy = generateStrategy();

  const result =
    await trainingEngine.runTrainingSession({
      tenantId,
      symbol,
      candles,
    });

  return {
    strategy,
    trainingResult: result,
  };

}

module.exports = {
  discoverStrategy,
};
