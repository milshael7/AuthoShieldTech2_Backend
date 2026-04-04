// ==========================================================
// 🔒 AUTOSHIELD CORE — v8.0 (ENGINE-LINKED & PERFORMANCE-OPTIMIZED)
// FILE: backend/src/services/marketEngine.js
// ==========================================================

const fs = require("fs");
const path = require("path");
// 🔥 THE MISSING LINK: Import the brain
const engineCore = require("../engine/engineCore");

/* ================= CONFIG ================= */
const STATE_DIR = process.env.MARKET_STATE_DIR || path.join("/tmp", "market_engine");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

const SYMBOLS = {
  BTCUSDT: { start: 65000, vol: 0.0005 }, // Reduced volatility for more realistic paper trading
  ETHUSDT: { start: 3500, vol: 0.0006 },
  SOLUSDT: { start: 150, vol: 0.0008 }
};

const TENANTS = new Map();

/* ================= SIMULATION ================= */
function simulate(price, vol) {
  const change = price * vol * (Math.random() - 0.5);
  return Number((price + change).toFixed(8));
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
    state.snapshot[sym] = { price: next };

    // 1. Update Candles
    updateCandle(state, sym, next, now);

    // 2. 🔥 TRIGGER THE BRAIN (The missing connection)
    // Every tick now asks the AI: "Should we buy/sell/close?"
    try {
      engineCore.processTick({
        tenantId,
        symbol: sym,
        price: next,
        ts: now
      });
    } catch (err) {
      console.error(`AI Engine Error [${tenantId}]:`, err.message);
    }
  }
}

function updateCandle(state, symbol, price, now) {
  if (!state.candles[symbol]) state.candles[symbol] = [];
  const arr = state.candles[symbol];
  const last = arr[arr.length - 1];

  // 1 Minute Candles (60000ms)
  if (!last || now - last.t >= 60000) {
    arr.push({ t: now, o: price, h: price, l: price, c: price });
    if (arr.length > 1000) arr.shift();
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

  TENANTS.set(id, {
    prices: {},
    snapshot: {},
    candles: {},
    lastTick: Date.now()
  });
  
  // Ensure engineCore initializes state for this tenant
  engineCore.getState(id);
}

function getMarketSnapshot(tenantId) {
  return TENANTS.get(String(tenantId))?.snapshot || {};
}

function getPrice(tenantId, symbol) {
  return TENANTS.get(String(tenantId))?.prices[symbol] || null;
}

function getCandles(tenantId, symbol) {
  const arr = TENANTS.get(String(tenantId))?.candles[symbol] || [];
  return arr.map(c => ({
    time: Math.floor(c.t / 1000),
    open: c.o, high: c.h, low: c.l, close: c.c
  }));
}

/* ================= ENGINE LOOP ================= */

// Run ticks for all active tenants
setInterval(() => {
  for (const tenantId of TENANTS.keys()) {
    tickTenant(tenantId);
  }
}, 500); // 500ms is more stable for Railway environments

module.exports = {
  registerTenant,
  getMarketSnapshot,
  getCandles,
  getPrice
};
