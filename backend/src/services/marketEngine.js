// ==========================================================
// 🔒 STEALTH PULSE — v9.0 (SYNCED & RENDER-OPTIMIZED)
// Replacement for: backend/src/services/marketEngine.js
// ==========================================================

const stealthCore = require("./paperTrader"); // The v53 Stealth Core
const { recordVisit } = require("./analyticsEngine");

/* ================= CONFIG ================= */
const SYMBOLS = {
  BTCUSDT: { start: 67200, vol: 0.0004 }, // Updated base price for 2026
  ETHUSDT: { start: 3800, vol: 0.0005 },
  SOLUSDT: { start: 185, vol: 0.0008 }
};

const TENANTS = new Map();

/* ================= SIMULATION ================= */
function simulate(price, vol) {
  // Adds a "Drift" so the AI sees trends, not just random noise
  const drift = (Math.random() - 0.48) * 0.0001; 
  const change = price * (vol * (Math.random() - 0.5) + drift);
  return Number((price + change).toFixed(2));
}

/* ================= CORE LOGIC ================= */

function tickTenant(tenantId) {
  const state = TENANTS.get(tenantId);
  if (!state) return;

  const now = Date.now();

  for (const sym in SYMBOLS) {
    const prev = state.prices[sym] || SYMBOLS[sym].start;
    const next = simulate(prev, SYMBOLS[sym].vol);

    state.prices[sym] = next;
    state.snapshot[sym] = { price: next, symbol: sym, ts: now };

    updateCandle(state, sym, next, now);

    // 🔥 SYNCED TO STEALTH CORE v53
    try {
      // We pass the tick to the Core, which triggers the Brain
      stealthCore.tick(tenantId, sym, next);
    } catch (err) {
      console.error(`⚠️ STEALTH SYNC ERROR [${tenantId}]:`, err.message);
    }
  }

  // 🛰️ RENDER KEEP-ALIVE: Tells Render "I am busy, don't sleep!"
  if (Math.random() > 0.98) {
    console.log(`[PULSE]: Active Learning for Tenant ${tenantId} | BTC: ${state.prices['BTCUSDT']}`);
  }
}

function updateCandle(state, symbol, price, now) {
  if (!state.candles[symbol]) state.candles[symbol] = [];
  const arr = state.candles[symbol];
  const last = arr[arr.length - 1];

  // 1-Minute Candle Logic
  if (!last || now - last.t >= 60000) {
    arr.push({ t: now, o: price, h: price, l: price, c: price });
    if (arr.length > 200) arr.shift(); // Keep memory lean for Render
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
}

/* ================= LIFECYCLE ================= */

function registerTenant(tenantId) {
  const id = String(tenantId);
  if (TENANTS.has(id)) return;

  console.log(`🚀 STEALTH INITIALIZED: Waking up AI for ${id}`);
  
  TENANTS.set(id, {
    prices: {},
    snapshot: {},
    candles: {},
    lastTick: Date.now()
  });
  
  // Initialize the Stealth Core state for this user
  stealthCore.snapshot(id);
}

function getMarketSnapshot(tenantId) {
  return TENANTS.get(String(tenantId))?.snapshot || {};
}

function getCandles(tenantId, symbol) {
  const arr = TENANTS.get(String(tenantId))?.candles[symbol] || [];
  return arr.map(c => ({
    time: Math.floor(c.t / 1000),
    open: c.o, high: c.h, low: c.l, close: c.c
  }));
}

/* ================= ENGINE LOOP ================= */

setInterval(() => {
  if (TENANTS.size === 0) return;
  for (const tenantId of TENANTS.keys()) {
    tickTenant(tenantId);
  }
}, 1000); // Optimized 1s loop for maximum Render stability

module.exports = {
  registerTenant,
  getMarketSnapshot,
  getCandles
};
