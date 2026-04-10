// ==========================================================
// 🔒 STEALTH PULSE — v9.2 (BRIDGE-COMPLIANT)
// FILE: backend/src/services/marketEngine.js
// ==========================================================

const stealthCore = require("./paperTrader"); 
const { recordVisit } = require("./analyticsEngine");

/* ================= CONFIG ================= */
const SYMBOLS = {
  BTCUSDT: { start: 67200, vol: 0.0004 }, 
  ETHUSDT: { start: 3800, vol: 0.0005 },
  SOLUSDT: { start: 185, vol: 0.0008 }
};

const TENANTS = new Map();

/* ================= SIMULATION ================= */
function simulate(price, vol) {
  const drift = (Math.random() - 0.49) * 0.0001; 
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

    try {
      stealthCore.tick(tenantId, sym, next);
    } catch (err) {
      // Silent recovery
    }
  }

  if (state.ticks % 60 === 0) {
    console.log(`[PULSE]: Active Learning | ID: ${tenantId} | Confidence: ${global.lastConfidence}%`);
  }
  state.ticks++;
}

function updateCandle(state, symbol, price, now) {
  if (!state.candles[symbol]) state.candles[symbol] = [];
  const arr = state.candles[symbol];
  const last = arr[arr.length - 1];

  if (!last || now - last.t >= 60000) {
    arr.push({ t: now, o: price, h: price, l: price, c: price });
    if (arr.length > 200) arr.shift();
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
}

/* ================= LIFECYCLE & HELPERS ================= */

function registerTenant(tenantId) {
  const id = String(tenantId || "default");
  if (TENANTS.has(id)) return;

  console.log(`🚀 AUTO-IGNITION: Waking up AI for [${id}]`);
  
  TENANTS.set(id, {
    prices: {},
    snapshot: {},
    candles: {},
    ticks: 0,
    lastTick: Date.now()
  });
  
  stealthCore.snapshot(id);
}

// v9.2: Auto-register default
registerTenant("default");

function getMarketSnapshot(tenantId) {
  const id = String(tenantId || "default");
  if (!TENANTS.has(id)) registerTenant(id);
  return TENANTS.get(id)?.snapshot || {};
}

function getCandles(tenantId, symbol) {
  const id = String(tenantId || "default");
  const arr = TENANTS.get(id)?.candles[symbol] || [];
  return arr.map(c => ({
    time: Math.floor(c.t / 1000),
    open: c.o, high: c.h, low: c.l, close: c.c
  }));
}

/**
 * 🛰️ STEP 2 FIX: Added getPrice helper
 * This ensures paper.routes.js can execute manual orders without crashing.
 */
function getPrice(tenantId, symbol) {
  const id = String(tenantId || "default");
  if (!TENANTS.has(id)) registerTenant(id);
  return TENANTS.get(id)?.prices?.[symbol] || 0;
}

/* ================= ENGINE LOOP ================= */

setInterval(() => {
  if (TENANTS.size === 0) return;
  for (const tenantId of TENANTS.keys()) {
    tickTenant(tenantId);
  }
}, 1000); 

module.exports = {
  registerTenant,
  getMarketSnapshot,
  getCandles,
  getPrice // <--- Exported for v13.0 Routes & v14.0 Server
};
