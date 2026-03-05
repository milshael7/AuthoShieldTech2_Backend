// backend/src/services/krakenConnector.js
// ==========================================================
// Kraken Exchange Connector
// Secure Signing • Balance Detection • Order Execution
// Production Safe
// ==========================================================

const crypto = require("crypto");
const fetch = require("node-fetch");

const API_KEY = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_SECRET;

const BASE_URL = "https://api.kraken.com";

const REQUEST_TIMEOUT =
  Number(process.env.EXCHANGE_TIMEOUT_MS || 8000);

/* =========================================================
UTIL
========================================================= */

function withTimeout(promise, ms) {

  let timeout;

  const timeoutPromise = new Promise((_, reject) => {

    timeout = setTimeout(() => {
      reject(new Error("Kraken request timeout"));
    }, ms);

  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeout));
}

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

  const request = fetch(BASE_URL + path, {

    method: "POST",

    headers: {
      "API-Key": API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded"
    },

    body: postData

  });

  const res =
    await withTimeout(request, REQUEST_TIMEOUT);

  let json;

  try {

    json = await res.json();

  } catch {

    throw new Error("Invalid Kraken response");

  }

  if (json.error && json.error.length) {

    throw new Error(json.error.join(","));

  }

  return json.result;

}

/* =========================================================
PUBLIC PRICE
========================================================= */

async function getTicker(pair = "BTCUSD") {

  try {

    const url =
      `${BASE_URL}/0/public/Ticker?pair=${pair}`;

    const res =
      await withTimeout(fetch(url), REQUEST_TIMEOUT);

    const json =
      await res.json();

    const data =
      Object.values(json.result)[0];

    const price =
      Number(data.c?.[0]);

    return Number.isFinite(price)
      ? price
      : null;

  } catch (err) {

    console.error("Kraken ticker error:", err);

    return null;

  }

}

/* =========================================================
ACCOUNT BALANCE
========================================================= */

async function getBalance() {

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
    action === "BUY"
      ? "buy"
      : "sell";

  const result =
    await placeOrder({
      pair: symbol,
      side,
      volume: qty
    });

  if (!result) {

    return {
      ok: false,
      error: "Order rejected by Kraken"
    };

  }

  return {

    ok: true,

    order: {
      txid: result.txid,
      descr: result.descr
    }

  };

}

/* =========================================================
EXPORT
========================================================= */

module.exports = {

  getBalance,
  getTicker,
  placeOrder,
  executeLiveOrder

};
