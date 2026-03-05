// ==========================================================
// Kraken Exchange Connector
// Handles account balance and order execution
// ==========================================================

const crypto = require("crypto");
const fetch = require("node-fetch");

const API_KEY = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_SECRET;

const BASE_URL = "https://api.kraken.com";

/* ================= UTIL ================= */

function getSignature(path, request, secret, nonce) {

  const message = nonce + request;
  const secretBuffer = Buffer.from(secret, "base64");

  const hash = crypto
    .createHash("sha256")
    .update(message)
    .digest();

  const hmac = crypto
    .createHmac("sha512", secretBuffer)
    .update(path + hash)
    .digest("base64");

  return hmac;

}

/* ================= PRIVATE REQUEST ================= */

async function privateRequest(path, body = {}) {

  const nonce = Date.now().toString();

  const payload = new URLSearchParams({
    nonce,
    ...body
  }).toString();

  const signature = getSignature(
    path,
    payload,
    API_SECRET,
    nonce
  );

  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: {
      "API-Key": API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload
  });

  return res.json();

}

/* ================= BALANCE ================= */

async function getBalance() {

  try {

    const data = await privateRequest("/0/private/Balance");

    if (data.error && data.error.length) {
      throw new Error(data.error.join(","));
    }

    return data.result;

  } catch (err) {

    console.error("Kraken balance error:", err);

    return null;

  }

}

/* ================= PLACE ORDER ================= */

async function placeOrder({ pair, side, volume, type = "market" }) {

  try {

    const data = await privateRequest("/0/private/AddOrder", {
      pair,
      type: side,
      ordertype: type,
      volume
    });

    return data;

  } catch (err) {

    console.error("Kraken order error:", err);

    return null;

  }

}

module.exports = {
  getBalance,
  placeOrder
};
