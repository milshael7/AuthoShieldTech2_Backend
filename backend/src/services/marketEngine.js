// --------------------------------------------------
// AutoShield — Market Engine (Institutional Final)
// Multi-Tenant • Deterministic • Candle Generator
// Feeds Paper + Live Engines
// --------------------------------------------------

const paperTrader = require("./paperTrader");
const liveTrader = require("./liveTrader");

/* ================= CONFIG ================= */

const CONFIG = {
  tickMs: 1000,
  candleMs: 60 * 1000,
  maxCandles: 2000,

  defaultSymbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],

  regimeTrendThreshold: 0.004,
  regimeVolatilityHigh: 0.015,
};

/* ================= STATE ================= */

const TENANTS = new Map();

/* ================= HELPERS ================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function seedFrom(tenantId, symbol) {
  const s = `${tenantId}:${symbol}`;
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function xorshift32(seed) {
  let x = seed | 0;

  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function basePrice(symbol) {
  switch (symbol) {
    case "BTCUSDT": return 65000;
    case "ETHUSDT": return 3500;
    case "SOLUSDT": return 150;
    case "XRPUSDT": return 0.6;
    default: return 100;
  }
}

/* ================= TENANT ================= */

function getTenant(tenantId) {

  if (!TENANTS.has(tenantId)) {

    const market = {
      prices: {},
      candles: {},
      volatility: {},
      regime: {},
    };

    for (const sym of CONFIG.defaultSymbols) {

      const rnd = xorshift32(seedFrom(tenantId, sym));
      const price = basePrice(sym);

      market.prices[sym] = { price, rnd };

      market.candles[sym] = [{
        t: Date.now(),
        o: price,
        h: price,
        l: price,
        c: price,
      }];

      market.volatility[sym] = 0.002;
      market.regime[sym] = "neutral";
    }

    TENANTS.set(tenantId, market);
  }

  return TENANTS.get(tenantId);
}

/* ================= CANDLES ================= */

function updateCandle(arr, price) {

  const c = arr[arr.length - 1];

  c.h = Math.max(c.h, price);
  c.l = Math.min(c.l, price);
  c.c = price;

}

function maybeRollCandle(arr) {

  const now = Date.now();
  const last = arr[arr.length - 1];

  if (now - last.t >= CONFIG.candleMs) {

    arr.push({
      t: now,
      o: last.c,
      h: last.c,
      l: last.c,
      c: last.c,
    });

    if (arr.length > CONFIG.maxCandles) {
      arr.splice(0, arr.length - CONFIG.maxCandles);
    }
  }
}

/* ================= REGIME ================= */

function detectRegime(volatility, move) {

  if (volatility > CONFIG.regimeVolatilityHigh)
    return "volatile";

  if (Math.abs(move) > CONFIG.regimeTrendThreshold)
    return "trend";

  return "range";

}

/* ================= MARKET TICK ================= */

function marketTick(tenantId) {

  const market = getTenant(tenantId);

  for (const sym of Object.keys(market.prices)) {

    const node = market.prices[sym];
    const rnd = node.rnd();

    const volatilityBase =
      sym === "BTCUSDT" ? 0.0025 :
      sym === "ETHUSDT" ? 0.0035 :
      sym === "SOLUSDT" ? 0.006 :
      sym === "XRPUSDT" ? 0.01 : 0.004;

    const drift = (rnd - 0.5) * 2 * volatilityBase;

    const prev = node.price;

    const next =
      clamp(prev * (1 + drift), 0.0001, 999999999);

    node.price = Number(next.toFixed(8));

    const move = (node.price - prev) / prev;

    /* ===== volatility tracking ===== */

    market.volatility[sym] =
      market.volatility[sym] * 0.9 +
      Math.abs(move) * 0.1;

    market.regime[sym] =
      detectRegime(market.volatility[sym], move);

    /* ===== candles ===== */

    const candles = market.candles[sym];

    maybeRollCandle(candles);
    updateCandle(candles, node.price);

    /* ===== feed engines ===== */

    try {
      paperTrader.tick(tenantId, sym, node.price);
    } catch {}

    try {
      liveTrader.tick(tenantId, sym, node.price);
    } catch {}

  }

}

/* ================= LOOP ================= */

setInterval(() => {

  for (const tenantId of TENANTS.keys()) {

    try {
      marketTick(tenantId);
    } catch {}

  }

}, CONFIG.tickMs);

/* ================= API ================= */

function registerTenant(tenantId) {

  getTenant(tenantId);

}

function getPrice(tenantId, symbol) {

  const market = getTenant(tenantId);

  return market.prices[symbol]?.price || null;

}

function getCandles(tenantId, symbol, limit = 200) {

  const market = getTenant(tenantId);

  const arr = market.candles[symbol] || [];

  return arr.slice(-limit).map(c => ({
    time: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  }));

}

function getMarketSnapshot(tenantId) {

  const market = getTenant(tenantId);

  const snapshot = {};

  for (const sym of Object.keys(market.prices)) {

    snapshot[sym] = {
      price: market.prices[sym].price,
      volatility: market.volatility[sym],
      regime: market.regime[sym],
    };

  }

  return snapshot;

}

/* ================= EXPORT ================= */

module.exports = {
  registerTenant,
  getPrice,
  getCandles,
  getMarketSnapshot,
};
