// ==========================================================
// Exchange Connector
// Routes orders to Kraken or paper trader depending on mode
// ==========================================================

const kraken = require("./krakenConnector");
const liveGuard = require("./liveTradingGuard");

/* =========================================================
EXECUTE ORDER
========================================================= */

async function executeOrder({

  symbol = "BTCUSD",
  action = "BUY",
  qty

}) {

  const canTrade =
    await liveGuard.canTradeLive();

  /* ===== PAPER MODE ===== */

  if (!canTrade) {

    console.log("[EXCHANGE] Paper mode active");

    return {

      ok: true,
      mode: "paper",
      order: {
        symbol,
        action,
        qty
      }

    };

  }

  /* ===== LIVE MODE ===== */

  try {

    const side =
      action === "BUY" ? "buy" : "sell";

    const result =
      await kraken.placeOrder({

        pair: symbol,
        side,
        volume: qty

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

/* =========================================================
BALANCE
========================================================= */

async function getBalance() {

  try {

    const balance =
      await kraken.getBalance();

    return balance;

  } catch (err) {

    console.error("Balance error:", err);

    return null;

  }

}

module.exports = {

  executeOrder,
  getBalance

};
