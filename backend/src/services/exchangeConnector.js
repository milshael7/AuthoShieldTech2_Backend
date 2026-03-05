// ==========================================================
// Exchange Connector
// Routes orders to Kraken or paper trader depending on mode
// ==========================================================

const kraken = require("./krakenConnector");
const liveGuard = require("./liveTradingGuard");

/* ================= EXECUTE ORDER ================= */

async function executeOrder({
  pair = "BTCUSD",
  side,
  volume
}) {

  const canTrade = await liveGuard.canTradeLive();

  if (!canTrade) {

    console.log("[EXCHANGE] Paper mode active");

    return {
      ok: true,
      mode: "paper",
      message: "Paper trade executed"
    };

  }

  try {

    const result = await kraken.placeOrder({
      pair,
      side,
      volume
    });

    return {
      ok: true,
      mode: "live",
      result
    };

  } catch (err) {

    console.error("Exchange order error:", err);

    return {
      ok: false,
      error: err.message
    };

  }

}

/* ================= BALANCE ================= */

async function getAccountBalance() {

  try {

    const balance = await kraken.getBalance();

    return balance;

  } catch (err) {

    console.error("Balance error:", err);
    return null;

  }

}

module.exports = {
  executeOrder,
  getAccountBalance
};
