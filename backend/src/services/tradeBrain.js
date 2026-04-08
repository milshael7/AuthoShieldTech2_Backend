// ==========================================================
// 🧠 STEALTH BRAIN — v26.1 (FAST SYNC & SCALE FIX)
// FILE: backend/src/services/tradeBrain.js
// ==========================================================

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */
const MIN_CONF_INT = 15; // 15% - Switched to Integer to match v53.1 Core
const TRADE_COOLDOWN_MS = 5000; // Reduced to 5s for better learning speed
const EXPLORATION_RATE = 0.08;  // Increased to 8% to force more "Learning" action

const BRAIN_STATE = new Map();

function getBrainState(id) {
  const key = String(id || "default");
  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.2, // Start slightly lower but more reactive
      edgeMomentum: 0,
      lastTradeTime: 0,
      priceMemory: [],
      regime: "INITIALIZING"
    });
  }
  return BRAIN_STATE.get(key);
}

function detectMarketRegime(prices) {
  if (prices.length < 10) return "LEARNING"; // Faster exit from "Observing"
  const start = prices[0];
  const end = prices[prices.length - 1];
  const move = (end - start) / start;
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

  // 🏛️ Strategy & AI Fusion
  let strategy = { action: "WAIT", confidence: 0.1, edge: 0 };
  let ai = { confidence: 0.1, edge: 0 };

  try {
    strategy = buildDecision({ tenantId, symbol, price, coreState: core }) || strategy;
  } catch (e) { /* Silent fail */ }

  try {
    ai = aiBrain.decide({ tenantId, symbol, last, core }) || ai;
  } catch (e) { /* Silent fail */ }

  // 🧪 Vercel-Ready Fusion (Shifted to 50/50 for faster reaction)
  let rawConf = (strategy.confidence || 0) * 0.5 + (ai.confidence || 0) * 0.5;
  let rawEdge = (strategy.edge || 0) * 0.5 + (ai.edge || 0) * 0.5;

  // 📉 Fast-Attack Smoothing (30% Old / 70% New)
  // This makes the UI needle jump much faster when price moves
  brain.smoothedConfidence = (brain.smoothedConfidence * 0.3) + (rawConf * 0.7);
  const finalConfidence = Math.min(Math.round(brain.smoothedConfidence * 100), 100);

  let action = strategy.action || "WAIT";

  // Exploration Mode (Force activity if market is moving but strategy is hesitant)
  if (action === "WAIT" && Math.random() < EXPLORATION_RATE && finalConfidence > 10) {
    action = rawEdge > 0 ? "BUY" : "SELL";
  }

  // 🛡️ Guard Rails
  if (now - brain.lastTradeTime < TRADE_COOLDOWN_MS) {
    if (action === "BUY" || action === "SELL") action = "WAIT";
  }

  // FIXED SCALE: Comparing Integer vs Integer (e.g., 20 > 15)
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
