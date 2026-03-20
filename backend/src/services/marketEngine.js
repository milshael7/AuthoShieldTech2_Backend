// ==========================================================
// FILE: backend/src/services/marketEngine.js
// MARKET ENGINE — Persistent Real-Time Exchange Simulator
// INSTITUTIONAL STABLE VERSION v7 (Fast Snapshot + Low-Overhead Persistence)
// PURPOSE
// - Keep server.js as the single AI driver
// - Make market delivery much faster and lighter
// - Reduce main-thread blocking from disk writes
// - Cache snapshot output for websocket broadcasting
// - Preserve persistence, candles, and multi-tenant behavior
// ==========================================================

const fs = require("fs");
const path = require("path");

/* ================= STORAGE ================= */

const STATE_DIR =
  process.env.MARKET_STATE_DIR ||
  path.join("/tmp", "market_engine");

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function stateFile(tenantId) {
  ensureDir();
  return path.join(STATE_DIR, `market_${tenantId}.json`);
}

/* ================= CONFIG ================= */

const SYMBOLS = Object.freeze({
  BTCUSDT: { start: 65000, vol: 0.0025 },
  ETHUSDT: { start: 3500, vol: 0.003 },
  SOLUSDT: { start: 150, vol: 0.004 },
  EURUSD: { start: 1.08, vol: 0.0004 },
  GBPUSD: { start: 1.27, vol: 0.0004 },
  SPX: { start: 5100, vol: 0.0007 },
  NASDAQ: { start: 17800, vol: 0.0008 },
  GOLD: { start: 2050, vol: 0.0006 },
});

const SYMBOL_LIST = Object.keys(SYMBOLS);

const MARKET_TICK_MS =
  Number(process.env.MARKET_TICK_MS || 200);

const CANDLE_MS =
  Number(process.env.MARKET_CANDLE_MS || 60000);

const MAX_CANDLES =
  Number(process.env.MARKET_MAX_CANDLES || 2000);

const SAVE_INTERVAL_MS =
  Number(process.env.MARKET_SAVE_INTERVAL_MS || 3000);

const SAVE_COOLDOWN_MS =
  Number(process.env.MARKET_SAVE_COOLDOWN_MS || 2500);

/* ================= TENANTS ================= */

const TENANTS = new Map();
const DIRTY = new Set();

/* ================= UTIL ================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTenantId(tenantId) {
  return String(tenantId || "__default__");
}

function simulate(price, vol) {
  const drift = (Math.random() - 0.5) * vol;
  const trend = (Math.random() - 0.5) * vol * 0.3;

  const next = price * (1 + drift + trend);

  return Number(
    clamp(next, 0.0000001, 1e12).toFixed(8)
  );
}

/* ================= STATE BUILDERS ================= */

function buildInitialState() {
  const now = Date.now();

  const state = {
    prices: {},
    candles: {},
    snapshot: {},
    dirty: false,
    lastTickAt: now,
    lastSaveAt: 0,
  };

  for (const sym of SYMBOL_LIST) {
    const start = safeNum(SYMBOLS[sym].start, 1);

    state.prices[sym] = start;

    state.candles[sym] = [
      {
        t: now,
        o: start,
        h: start,
        l: start,
        c: start,
      },
    ];

    state.snapshot[sym] = { price: start };
  }

  return state;
}

function sanitizeLoadedState(raw) {
  const now = Date.now();
  const state = {
    prices: {},
    candles: {},
    snapshot: {},
    dirty: false,
    lastTickAt: now,
    lastSaveAt: 0,
  };

  for (const sym of SYMBOL_LIST) {
    const def = safeNum(SYMBOLS[sym].start, 1);
    const loadedPrice = safeNum(raw?.prices?.[sym], def);

    state.prices[sym] = loadedPrice;
    state.snapshot[sym] = { price: loadedPrice };

    const loadedCandles = Array.isArray(raw?.candles?.[sym])
      ? raw.candles[sym]
      : [];

    const cleaned = loadedCandles
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        t: safeNum(c.t, now),
        o: safeNum(c.o, loadedPrice),
        h: safeNum(c.h, loadedPrice),
        l: safeNum(c.l, loadedPrice),
        c: safeNum(c.c, loadedPrice),
      }))
      .slice(-MAX_CANDLES);

    state.candles[sym] =
      cleaned.length > 0
        ? cleaned
        : [
            {
              t: now,
              o: loadedPrice,
              h: loadedPrice,
              l: loadedPrice,
              c: loadedPrice,
            },
          ];
  }

  return state;
}

/* ================= LOAD ================= */

function loadState(tenantId) {
  const file = stateFile(tenantId);

  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf-8")
    );

    return sanitizeLoadedState(parsed);
  } catch {
    console.warn(
      "marketEngine corrupted state reset:",
      tenantId
    );

    return null;
  }
}

/* ================= SAVE ================= */

function buildPersistedState(state) {
  return {
    prices: state.prices,
    candles: state.candles,
  };
}

function saveState(tenantId, state) {
  try {
    const file = stateFile(tenantId);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(buildPersistedState(state))
    );

    fs.renameSync(tmp, file);

    state.lastSaveAt = Date.now();
    state.dirty = false;
  } catch (err) {
    console.warn(
      "marketEngine save failed:",
      err.message
    );
  }
}

/* ================= REGISTER ================= */

function registerTenant(tenantId) {
  const key = normalizeTenantId(tenantId);

  if (TENANTS.has(key)) {
    return;
  }

  const persisted = loadState(key);

  if (persisted) {
    TENANTS.set(key, persisted);
    return;
  }

  TENANTS.set(key, buildInitialState());
}

/* ================= SAFE ACCESS ================= */

function ensureTenant(tenantId) {
  const key = normalizeTenantId(tenantId);

  if (!TENANTS.has(key)) {
    registerTenant(key);
  }

  return key;
}

/* ================= GET PRICE ================= */

function getPrice(tenantId, symbol) {
  const key = ensureTenant(tenantId);
  const sym = String(symbol || "").toUpperCase();
  const state = TENANTS.get(key);

  return state?.prices?.[sym] ?? null;
}

/* ================= CANDLE UPDATE ================= */

function updateCandle(state, symbol, price, now) {
  if (!state.candles[symbol]) {
    state.candles[symbol] = [];
  }

  const arr = state.candles[symbol];

  if (arr.length === 0) {
    arr.push({
      t: now,
      o: price,
      h: price,
      l: price,
      c: price,
    });

    return;
  }

  const last = arr[arr.length - 1];

  if (now - safeNum(last.t, now) >= CANDLE_MS) {
    arr.push({
      t: now,
      o: price,
      h: price,
      l: price,
      c: price,
    });

    if (arr.length > MAX_CANDLES) {
      arr.splice(0, arr.length - MAX_CANDLES);
    }

    return;
  }

  last.h = Math.max(safeNum(last.h, price), price);
  last.l = Math.min(safeNum(last.l, price), price);
  last.c = price;
}

/* ================= MARKET TICK ================= */

function tickTenant(tenantId) {
  const key = ensureTenant(tenantId);
  const state = TENANTS.get(key);

  if (!state) return;

  const now = Date.now();

  for (const sym of SYMBOL_LIST) {
    const prev = safeNum(
      state.prices[sym],
      safeNum(SYMBOLS[sym]?.start, 1)
    );

    const next = simulate(prev, safeNum(SYMBOLS[sym]?.vol, 0.001));

    state.prices[sym] = next;

    // cached websocket snapshot object
    if (!state.snapshot[sym]) {
      state.snapshot[sym] = { price: next };
    } else {
      state.snapshot[sym].price = next;
    }

    updateCandle(state, sym, next, now);
  }

  state.lastTickAt = now;
  state.dirty = true;
  DIRTY.add(key);
}

/* ================= SNAPSHOT ================= */

function getMarketSnapshot(tenantId) {
  const key = ensureTenant(tenantId);
  const state = TENANTS.get(key);

  return state?.snapshot || {};
}

/* ================= CANDLES ================= */

function getCandles(tenantId, symbol, limit = 200) {
  const key = ensureTenant(tenantId);
  const sym = String(symbol || "").toUpperCase();
  const state = TENANTS.get(key);

  const cappedLimit = clamp(safeNum(limit, 200), 1, MAX_CANDLES);
  const arr = state?.candles?.[sym] || [];

  return arr.slice(-cappedLimit).map((c) => ({
    time: Math.floor(safeNum(c.t, 0) / 1000),
    open: safeNum(c.o),
    high: safeNum(c.h),
    low: safeNum(c.l),
    close: safeNum(c.c),
  }));
}

/* ================= ENGINE LOOP ================= */

setInterval(() => {
  for (const tenantId of TENANTS.keys()) {
    try {
      tickTenant(tenantId);
    } catch {}
  }
}, MARKET_TICK_MS);

setInterval(() => {
  const now = Date.now();

  for (const tenantId of DIRTY) {
    const state = TENANTS.get(tenantId);

    if (!state) {
      DIRTY.delete(tenantId);
      continue;
    }

    if (!state.dirty) {
      DIRTY.delete(tenantId);
      continue;
    }

    if (now - safeNum(state.lastSaveAt, 0) < SAVE_COOLDOWN_MS) {
      continue;
    }

    saveState(tenantId, state);
    DIRTY.delete(tenantId);
  }
}, SAVE_INTERVAL_MS);

/* ================= EXPORT ================= */

module.exports = {
  registerTenant,
  getMarketSnapshot,
  getCandles,
  getPrice,
};
