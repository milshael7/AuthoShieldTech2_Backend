// ==========================================================
// Kraken Exchange Connector
// Secure Signing • Balance Detection • Order Execution
// ==========================================================

const crypto = require("crypto");
const fetch = require("node-fetch");

const API_KEY = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_SECRET;

const BASE_URL = "https://api.kraken.com";

/* =========================================================
UTIL
========================================================= */

function signKrakenRequest(path, nonce, body) {

  const postData = new URLSearchParams({
    nonce,
    ...body
  }).toString();

  const hash = crypto
    .createHash("sha256")
    .update(nonce + postData)
    .digest();

  const hmac = crypto
    .createHmac("sha512", Buffer.from(API_SECRET, "base64"))
    .update(path + hash)
    .digest("base64");

  return { signature: hmac, postData };
}

/* =========================================================
PRIVATE REQUEST
========================================================= */

async function privateRequest(path, body = {}) {

  if (!API_KEY || !API_SECRET) {
    throw new Error("Kraken API keys missing");
  }

  const nonce = Date.now().toString();

  const { signature, postData } =
    signKrakenRequest(path, nonce, body);

  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: {
      "API-Key": API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: postData
  });

  const json = await res.json();

  if (json.error && json.error.length) {
    throw new Error(json.error.join(","));
  }

  return json.result;
}

/* =========================================================
ACCOUNT BALANCE
========================================================= */

async function getAccountBalance() {

  try {

    const result =
      await privateRequest("/0/private/Balance");

    return result;

  } catch (err) {

    console.error("Kraken balance error:", err);

    return null;

  }

}

/* =========================================================
PLACE ORDER
========================================================= */

async function placeOrder({
  pair = "BTCUSD",
  side = "buy",
  volume,
  type = "market"
}) {

  try {

    const result =
      await privateRequest("/0/private/AddOrder", {
        pair,
        type: side,
        ordertype: type,
        volume
      });

    return result;

  } catch (err) {

    console.error("Kraken order error:", err);

    return null;

  }

}

/* =========================================================
LIVE EXECUTION ADAPTER
========================================================= */

async function executeLiveOrder({
  symbol = "BTCUSD",
  action = "BUY",
  qty
}) {

  const side =
    action === "BUY" ? "buy" : "sell";

  const result =
    await placeOrder({
      pair: symbol,
      side,
      volume: qty
    });

  return {
    ok: true,
    order: result
  };

}

module.exports = {
  getAccountBalance,
  placeOrder,
  executeLiveOrder
};
