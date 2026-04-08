// ==========================================================
// 🧠 ENGINE CORE — v15.1 (STABLE TRANSLATION & HEARTBEAT)
// FILE: backend/src/engine/engineCore.js
// ==========================================================

const stealthCore = require("../services/paperTrader"); // Sync with v53.1
const tradeBrain = require("../services/tradeBrain");   // Sync with v26.1

const ENGINE_STATE = {
  bootTime: Date.now(),
  lastAction: "IDLE",
  totalProcessed: 0
};

/**
 * ⚡ PROCESS TICK
 * Routes data from marketEngine to StealthCore
 */
function processTick({ tenantId, symbol, price, ts }) {
  ENGINE_STATE.totalProcessed++;
  
  // Hand off to the Stealth Core (v53.1)
  // This now updates global.lastConfidence automatically
  return stealthCore.tick(tenantId, symbol, price);
}

/**
 * 📊 GET LEARNING STATS
 * Formats data for the "Render Status: STABLE" Dashboard
 */
function getLearningStats(tenantId = "default") {
  const snapshot = stealthCore.snapshot(tenantId);
  const brain = tradeBrain.getBrainState(tenantId);

  // Calculate Accuracy based on PnL history
  const history = snapshot.history || [];
  const wins = history.filter(t => t.pnl > 0).length;
  const total = history.length;
  
  // v15.1 Fix: Ensure we don't return "NaN" or "Infinity" if history is wiped
  const accuracyPct = total > 0 
    ? ((wins / total) * 100).toFixed(1) + "%" 
    : "LEARNING...";

  return {
    accuracy: accuracyPct,
    trades: total,
    // Pulling the forced global from PaperTrader v53.1
    confidence: global.lastConfidence || 0,
    regime: brain.regime || "OBSERVING",
    // Stats for the "Brain" pulse
    signals: snapshot.stats?.signals || 0,
    uptime: Math.floor((Date.now() - ENGINE_STATE.bootTime) / 60000) + "m"
  };
}

function getState(tenantId) {
  return stealthCore.snapshot(tenantId);
}

module.exports = {
  processTick,
  getLearningStats,
  getState
};
