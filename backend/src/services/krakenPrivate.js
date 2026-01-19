// backend/src/services/krakenPrivate.js
// Kraken Private REST API helper (signed requests)
// NOTE: Funds stay on Kraken. This just verifies keys + reads balances, etc.

const crypto = require('crypto');

const BASE_URL = 'https://api.kraken.com';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getKeys() {
  const key = requireEnv('KRAKEN_API_KEY');
  const secret = requireEnv('KRAKEN_API_SECRET');
  return { key, secret };
}

function b64ToBuf(b64) {
  return Buffer.from(b64, 'base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hmacSha512(secretBuf, msgBuf) {
  return crypto.createHmac('sha512', secretBuf).update(msgBuf).digest('base64');
}

async function privateRequest(path, bodyObj = {}) {
  const { key, secret } = getKeys();

  const nonce = Date.now().toString();
  const form = new URLSearchParams({ nonce, ...bodyObj }).toString();

  // Kraken signature: HMAC-SHA512( base64_decode(secret), uri_path + SHA256(nonce + POSTDATA) )
  const hash = sha256(Buffer.from(nonce + form));
  const msg = Buffer.concat([Buffer.from(path), hash]);
  const sig = hmacSha512(b64ToBuf(secret), msg);

  const url = BASE_URL + path;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-Key': key,
      'API-Sign': sig,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error || [`HTTP_${res.status}`];
    throw new Error(`Kraken error: ${Array.isArray(err) ? err.join(',') : String(err)}`);
  }

  if (json?.error?.length) {
    throw new Error(`Kraken error: ${json.error.join(',')}`);
  }

  return json.result;
}

// ---------- Public helpers ----------

async function getBalance() {
  // returns object like { ZUSD:"12.34", XXBT:"0.001", ... }
  return privateRequest('/0/private/Balance', {});
}

async function getOpenOrders() {
  return privateRequest('/0/private/OpenOrders', {});
}

function liveConfig() {
  const enabled = String(process.env.LIVE_TRADING_ENABLED || 'false').toLowerCase() === 'true';
  const dryRun = String(process.env.LIVE_TRADE_DRY_RUN || 'true').toLowerCase() === 'true';
  return { enabled, dryRun };
}

module.exports = {
  privateRequest,
  getBalance,
  getOpenOrders,
  liveConfig,
};
