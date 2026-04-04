// ==========================================================
// 🔒 AUTOSHIELD MARKET ENGINE — v8.1 (LIVELY & AUTO-START)
// FILE: backend/src/services/marketEngine.js
// ==========================================================

const fs = require("fs");
const path = require("path");
const engineCore = require("../engine/engineCore");
const { recordVisit } = require("./analyticsEngine"); // Sync with Analytics

/* ================= CONFIG ================= */
const SYMBOLS = {
  BTCUSDT: { start: 65000, vol: 0.0005 },
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
    state.snapshot[sym] = { price: next, symbol: sym, ts: now };

    // 1. Update Candles for Charting
    updateCandle(state, sym, next, now);

    // 2. 🔥 TRIGGER THE BRAIN
    try {
      // This is the hand-in-hand connection to engineCore
      engineCore.processTick({
        tenantId,
        symbol: sym,
        price: next,
        ts: now
      });
    } catch (err) {
      // Don't swallow the error silently—log it so we can fix it
      console.error(`⚠️ AI BRAIN ERROR [${tenantId}]:`, err.message);
    }
  }

  // 3. LIVELY PULSE: Record a "Thinking" event every 20 ticks (approx 10s)
  if (Math.random() > 0.95) {
    recordVisit({
      type: "AI_HEARTBEAT",
      path: "/engine",
      source: "marketEngine",
      tenantId: tenantId
    });
  }
}

function updateCandle(state, symbol, price, now) {
  if (!state.candles[symbol]) state.candles[symbol] = [];
  const arr = state.candles[symbol];
  const last = arr[arr.length - 1];

  if (!last || now - last.t >= 60000) {
    arr.push({ t: now, o: price, h: price, l: price, c: price });
    if (arr.length > 500) arr.shift();
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
}

/* ================= LIFECYCLE ================= */

function registerTenant(tenantId) {
  const id = String(tenantId);
  if (TENANTS.has(id)) {
    console.log(`🟢 Tenant ${id} already active.`);
    return;
  }

  console.log(`🚀 Waking up AI for Tenant: ${id}`);
  
  TENANTS.set(id, {
    prices: {},
    snapshot: {},
    candles: {},
    lastTick: Date.now()
  });
  
  // Ensure engineCore is ready for this user
  if (engineCore.getState) {
    engineCore.getState(id);
  }
}

function getMarketSnapshot(tenantId) {
  const data = TENANTS.get(String(tenantId))?.snapshot;
  return data || {};
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

// Main loop: This is the heartbeat of the entire backend
setInterval(() => {
  if (TENANTS.size === 0) {
    // If no one is logged in, the engine stays quiet to save Render CPU
    return;
  }
  
  for (const tenantId of TENANTS.keys()) {
    tickTenant(tenantId);
  }
}, 500); 

module.exports = {
  registerTenant,
  getMarketSnapshot,
  getCandles,
  getPrice
};
