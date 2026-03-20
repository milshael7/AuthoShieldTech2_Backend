// ==========================================================
// FILE: backend/src/services/marketReplayEngine.js
// VERSION: v2.0 (Maintenance-Safe Market Replay Engine)
// PURPOSE
// - Load historical candle files safely
// - Normalize dirty candle formats
// - Return stable replay-ready candles for training/testing
// - Stay resilient during maintenance and backend drift
// ==========================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR =
  process.env.MARKET_DATA_DIR ||
  path.join(process.cwd(), "backend/data/market_data");

const DEFAULT_LIMIT =
  Number(process.env.MARKET_REPLAY_LIMIT || 1000);

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeSymbol(symbol = "BTCUSDT") {
  return String(symbol || "BTCUSDT").trim().toUpperCase();
}

function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch {}
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[marketReplayEngine] JSON read error:", err.message);
    return null;
  }
}

function candleTime(candle, index = 0) {
  const raw =
    candle?.time ??
    candle?.ts ??
    candle?.timestamp ??
    candle?.openTime ??
    candle?.closeTime ??
    candle?.date ??
    index;

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return date.getTime();
  }

  const n = Number(raw);
  if (Number.isFinite(n)) return n;

  return index;
}

/* =========================================================
CANDLE NORMALIZATION
Supports common formats:
- { open, high, low, close, volume, time }
- arrays like [time, open, high, low, close, volume]
========================================================= */

function normalizeArrayCandle(raw, index = 0) {
  if (!Array.isArray(raw)) return null;

  const time = candleTime(
    {
      time: raw[0],
      openTime: raw[0],
      closeTime: raw[6],
    },
    index
  );

  const open = safeNum(raw[1], NaN);
  const high = safeNum(raw[2], NaN);
  const low = safeNum(raw[3], NaN);
  const close = safeNum(raw[4], NaN);
  const volume = safeNum(raw[5], 0);

  if (![open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
  };
}

function normalizeObjectCandle(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const open = safeNum(raw.open ?? raw.o, NaN);
  const high = safeNum(raw.high ?? raw.h, NaN);
  const low = safeNum(raw.low ?? raw.l, NaN);
  const close = safeNum(raw.close ?? raw.c, NaN);
  const volume = safeNum(raw.volume ?? raw.v, 0);

  if (![open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  return {
    time: candleTime(raw, index),
    open,
    high,
    low,
    close,
    volume,
  };
}

function normalizeCandle(raw, index = 0) {
  if (Array.isArray(raw)) return normalizeArrayCandle(raw, index);
  if (raw && typeof raw === "object") return normalizeObjectCandle(raw, index);
  return null;
}

function sanitizeCandle(candle) {
  if (!candle) return null;

  let open = safeNum(candle.open, NaN);
  let high = safeNum(candle.high, NaN);
  let low = safeNum(candle.low, NaN);
  let close = safeNum(candle.close, NaN);
  const volume = safeNum(candle.volume, 0);
  const time = safeNum(candle.time, NaN);

  if (![open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  const top = Math.max(open, high, low, close);
  const bottom = Math.min(open, high, low, close);

  high = Math.max(high, top);
  low = Math.min(low, bottom);

  if (!Number.isFinite(time)) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
  };
}

function normalizeCandles(input) {
  const list = asArray(input);
  const out = [];

  for (let i = 0; i < list.length; i += 1) {
    const normalized = normalizeCandle(list[i], i);
    const clean = sanitizeCandle(normalized);

    if (clean) out.push(clean);
  }

  out.sort((a, b) => a.time - b.time);

  return out;
}

/* =========================================================
FILE ACCESS
========================================================= */

function getMarketFilePath(symbol = "BTCUSDT") {
  const normalized = normalizeSymbol(symbol);
  return path.join(DATA_DIR, `${normalized}.json`);
}

function loadMarketData(symbol = "BTCUSDT") {
  try {
    ensureDir(DATA_DIR);

    const file = getMarketFilePath(symbol);
    const parsed = readJsonFile(file);

    if (!parsed) return [];

    const rawCandles = Array.isArray(parsed)
      ? parsed
      : asArray(parsed?.candles).length
        ? parsed.candles
        : asArray(parsed?.data).length
          ? parsed.data
          : asArray(parsed?.results);

    return normalizeCandles(rawCandles);
  } catch (err) {
    console.error("[marketReplayEngine] Replay load error:", err.message);
    return [];
  }
}

/* =========================================================
REPLAY ACCESS
========================================================= */

function replayCandles({
  symbol = "BTCUSDT",
  limit = DEFAULT_LIMIT,
  fromTime = null,
  toTime = null,
} = {}) {
  const candles = loadMarketData(symbol);

  if (!candles.length) return [];

  const from = Number.isFinite(Number(fromTime)) ? Number(fromTime) : null;
  const to = Number.isFinite(Number(toTime)) ? Number(toTime) : null;
  const boundedLimit =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Number(limit)
      : DEFAULT_LIMIT;

  let filtered = candles;

  if (from !== null) {
    filtered = filtered.filter((c) => c.time >= from);
  }

  if (to !== null) {
    filtered = filtered.filter((c) => c.time <= to);
  }

  if (!filtered.length) return [];

  return filtered.slice(-boundedLimit);
}

/* =========================================================
DEBUG / METADATA
========================================================= */

function getReplayMeta(symbol = "BTCUSDT") {
  const candles = loadMarketData(symbol);

  if (!candles.length) {
    return {
      ok: true,
      symbol: normalizeSymbol(symbol),
      candles: 0,
      firstTime: null,
      lastTime: null,
      file: getMarketFilePath(symbol),
    };
  }

  return {
    ok: true,
    symbol: normalizeSymbol(symbol),
    candles: candles.length,
    firstTime: candles[0]?.time || null,
    lastTime: candles[candles.length - 1]?.time || null,
    file: getMarketFilePath(symbol),
  };
}

module.exports = {
  loadMarketData,
  replayCandles,
  getReplayMeta,
};
