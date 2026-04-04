// ==========================================================
// 🧠 ENGINE CORE — v15.0 (LOGIC ONLY / NO WEB CONFLICTS)
// FILE: backend/src/engine/engineCore.js
// ==========================================================

const stealthCore = require("../services/paperTrader"); // Sync with v53
const tradeBrain = require("../services/tradeBrain");   // Sync with v26

// 🔒 INTERNAL STATE (Private to the Engine)
const ENGINE_STATE = {
  bootTime: Date.now(),
  lastAction: "IDLE",
  totalProcessed: 0
};

/**
 * ⚡ PROCESS TICK
 * This is called by marketEngine.js (v9.0)
 */
function processTick({ tenantId, symbol, price, ts }) {
  ENGINE_STATE.totalProcessed++;
  
  // Hand off to the Stealth Core for execution & brain logic
  // This is the heartbeat of the v53 system
  return stealthCore.tick(tenantId, symbol, price);
}

/**
 * 📊 GET LEARNING STATS
 * This is called by server.js (v32.5) for your "Happy Person" dashboard
 */
function getLearningStats(tenantId = "default") {
  const snapshot = stealthCore.snapshot(tenantId);
  const brain = tradeBrain.getBrainState(tenantId);

  // Calculate Accuracy based on PnL history
  const history = snapshot.history || [];
  const wins = history.filter(t => t.pnl > 0).length;
  const total = history.length;
  
  const accuracyPct = total > 0 
    ? ((wins / total) * 100).toFixed(1) + "%" 
    : "CALIBRATING...";

  return {
    accuracy: accuracyPct,
    trades: total,
    confidence: global.lastConfidence || 0,
    regime: brain.regime || "OBSERVING",
    uptime: Math.floor((Date.now() - ENGINE_STATE.bootTime) / 60000) + "m"
  };
}

/**
 * 🚜 GET STATE
 * Used by routes to fetch the full snapshot
 */
function getState(tenantId) {
  return stealthCore.snapshot(tenantId);
}

module.exports = {
  processTick,
  getLearningStats,
  getState
};
