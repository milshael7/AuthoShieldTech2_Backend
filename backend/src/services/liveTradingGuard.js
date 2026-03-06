// ==========================================================
// Live Trading Guard
// Controls whether the AI is allowed to execute real trades
// ==========================================================

const kraken = require("./krakenConnector");

/* ================= CONFIG ================= */

let LIVE_TRADING_ENABLED = false;

/* =========================================================
   MANUAL SWITCH (FROM AI CONTROL PANEL)
========================================================= */

function enableLiveTrading() {
  LIVE_TRADING_ENABLED = true;
}

function disableLiveTrading() {
  LIVE_TRADING_ENABLED = false;
}

function isLiveTradingEnabled() {
  return LIVE_TRADING_ENABLED;
}

/* =========================================================
   SAFE LIVE CHECK
   Determines whether real trading is allowed
========================================================= */

async function canTradeLive() {

  // kill switch disabled
  if (!LIVE_TRADING_ENABLED) {
    return false;
  }

  try {

    const balance = await kraken.getBalance();

    if (!balance) {
      return false;
    }

    const usd =
      Number(balance.ZUSD || balance.USD || 0);

    // no capital → fallback to paper
    if (!Number.isFinite(usd) || usd <= 0) {
      return false;
    }

    return true;

  } catch {

    // exchange unavailable → fallback to paper
    return false;

  }

}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  enableLiveTrading,
  disableLiveTrading,
  isLiveTradingEnabled,
  canTradeLive
};
