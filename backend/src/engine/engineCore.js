// ==========================================================
// 🔒 AUTOSHIELD BRAIN — v6.2 (UNIVERSAL SYNC)
// FILE: backend/src/engine/engineCore.js
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");

const ENGINE_STATE = new Map();

function getState(tenantId) {
  // FALLBACK: If tenantId is missing/null, use "guest" so memory still works
  const key = tenantId && tenantId !== "undefined" ? String(tenantId) : "guest";
  
  if (!ENGINE_STATE.has(key)) {
    console.log(`🧠 Initializing Brain for: ${key}`);
    ENGINE_STATE.set(key, {
      positions: { scalp: null },
      priceHistory: [], 
      metrics: { confidence: 0, velocity: 0, memoryUsage: 0 },
      executionStats: { ticks: 0, decisions: 0, trades: 0 }
    });
  }
  return ENGINE_STATE.get(key);
}

function processTick({ tenantId, symbol, price, ts = Date.now() }) {
  const state = getState(tenantId);
  state.executionStats.ticks++;

  // 1. UPDATE MEMORY
  state.priceHistory.push(Number(price));
  if (state.priceHistory.length > 50) state.priceHistory.shift();
  
  // Calculate Memory % for the UI
  state.metrics.memoryUsage = Math.round((state.priceHistory.length / 50) * 100);

  // 2. CALCULATE VELOCITY & CONFIDENCE
  if (state.priceHistory.length > 5) {
    const start = state.priceHistory[0];
    const last = state.priceHistory[state.priceHistory.length - 1];
    state.metrics.velocity = Number(((last - start) / start * 1000).toFixed(4));
    state.metrics.confidence = Math.min(Math.abs(state.metrics.velocity * 500), 100);
  }

  // 3. BROADCAST TO DASHBOARD (Lively Sync)
  // This ensures the "Memory" bar moves on your screen!
  if (global.broadcastEngineStatus) {
    global.broadcastEngineStatus(tenantId, {
      memory: state.metrics.memoryUsage,
      confidence: state.metrics.confidence,
      velocity: state.metrics.velocity,
      ticks: state.executionStats.ticks
    });
  }

  // 4. TRADE LOGIC (Simplified for high activity)
  if (!state.positions.scalp && state.metrics.confidence > 20) {
    const side = state.metrics.velocity > 0 ? "BUY" : "SELL";
    state.executionStats.decisions++;
    
    const res = executePaperOrder({
      tenantId, symbol, side, price,
      qty: 0.1,
      state, ts
    });

    if (res?.ok) {
      state.executionStats.trades++;
      state.positions.scalp = res.trade;
    }
  }

  return null;
}

module.exports = { processTick, getState };
