// ==========================================================
// 🧠 STEALTH BRAIN — v26.2 (FAST SYNC & SCALE FIX)
// FILE: backend/src/services/tradeBrain.js
// ==========================================================

// 🛰️ PUSH 5.3 FIX: Safe imports with fallback for local dev
let aiBrain = { decide: () => ({ confidence: 0.1, edge: 0 }) };
let strategyEngine = { buildDecision: () => ({ action: "WAIT", confidence: 0.1, edge: 0 }) };

try {
  aiBrain = require("../../brain/aiBrain");
} catch (e) { console.warn("[BRAIN]: AI Module offline, using heuristic fallback."); }

try {
  const { buildDecision } = require("./strategyEngine");
  strategyEngine.buildDecision = buildDecision;
} catch (e) { console.warn("[BRAIN]: Strategy Engine offline, using neutral fallback."); }

/* ================= CONFIG ================= */
const MIN_CONF_INT = 15; 
const TRADE_COOLDOWN_MS = 5000; 
const EXPLORATION_RATE = 0.08;  

const BRAIN_STATE = new Map();

function getBrainState(id) {
  const key = String(id || "default");
  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.2,
      edgeMomentum: 0,
      lastTradeTime: 0,
      priceMemory: [],
      regime: "INITIALIZING"
    });
  }
  return BRAIN_STATE.get(key);
}

function detectMarketRegime(prices) {
  if (prices.length < 10) return "LEARNING";
  const start = prices[0];
  const end = prices[prices.length - 1];
  const move = (end - start) / start;
  // Threshold for "Stable" vs "Trending"
  if (Math.abs(move) < 0.0005) return "STABLE"; 
  return move > 0 ? "BULL_RUN" : "BEAR_PRESSURE";
}

function makeDecision(context = {}) {
  const { tenantId, symbol = "BTCUSDT", last, core = {} } = context;
  const brain = getBrainState(tenantId);
  const price = Number(last);
  const now = Date.now();

  if (!price || price <= 0) return { action: "WAIT", confidence: 0 };

  brain.priceMemory.push(price);
  if (brain.priceMemory.length > 50) brain.priceMemory.shift();
  brain.regime = detectMarketRegime(brain.priceMemory);

  // 🏛️ Strategy & AI Fusion (50/50 weighted split)
  let strategy = strategyEngine.buildDecision({ tenantId, symbol, price, coreState: core });
  let ai = aiBrain.decide({ tenantId, symbol, last, core });

  let rawConf = (strategy.confidence || 0) * 0.5 + (ai.confidence || 0) * 0.5;
  let rawEdge = (strategy.edge || 0) * 0.5 + (ai.edge || 0) * 0.5;

  // 📉 FAST-ATTACK SMOOTHING: 70% weight on newest data
  brain.smoothedConfidence = (brain.smoothedConfidence * 0.3) + (rawConf * 0.7);
  const finalConfidence = Math.min(Math.round(brain.smoothedConfidence * 100), 100);

  let action = strategy.action || "WAIT";

  // 🧪 EXPLORATION OVERRIDE
  if (action === "WAIT" && Math.random() < EXPLORATION_RATE && finalConfidence > 10) {
    action = rawEdge > 0 ? "BUY" : "SELL";
  }

  // 🛡️ COOLDOWN & THRESHOLD GUARDS
  if (now - brain.lastTradeTime < TRADE_COOLDOWN_MS) {
    if (action === "BUY" || action === "SELL") action = "WAIT";
  }

  if ((action === "BUY" || action === "SELL") && finalConfidence < MIN_CONF_INT) {
    action = "WAIT";
  }

  if (action === "BUY" || action === "SELL") brain.lastTradeTime = now;

  return {
    symbol,
    action,
    confidence: finalConfidence, 
    edge: rawEdge,
    regime: brain.regime,
    reason: action === "WAIT" ? "MARKET_SCAN" : "ALGO_CONFIRMED",
    ts: now
  };
}

module.exports = { makeDecision, getBrainState };
