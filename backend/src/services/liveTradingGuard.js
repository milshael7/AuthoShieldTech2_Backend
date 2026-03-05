// ==========================================================
// Live Trading Guard
// Prevents AI from trading unless conditions are safe
// ==========================================================

const kraken = require("./krakenConnector");

/* ================= CONFIG ================= */

let LIVE_TRADING_ENABLED = false;

/* ================= SWITCH ================= */

function enableLiveTrading() {
  LIVE_TRADING_ENABLED = true;
}

function disableLiveTrading() {
  LIVE_TRADING_ENABLED = false;
}

function isLiveTradingEnabled() {
  return LIVE_TRADING_ENABLED;
}

/* ================= BALANCE CHECK ================= */

async function canTradeLive() {

  if (!LIVE_TRADING_ENABLED) {
    return false;
  }

  const balance = await kraken.getBalance();

  if (!balance) {
    return false;
  }

  const usd =
    Number(balance.ZUSD || balance.USD || 0);

  if (usd <= 0) {
    return false;
  }

  return true;

}

module.exports = {
  enableLiveTrading,
  disableLiveTrading,
  isLiveTradingEnabled,
  canTradeLive
};
