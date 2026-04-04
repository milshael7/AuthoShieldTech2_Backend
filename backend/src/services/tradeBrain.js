// ==========================================================
// 🧠 STEALTH BRAIN — v26.0 (WORLD MARKET ALIGNMENT)
// Replacement for: backend/src/services/tradeBrain.js
// ==========================================================

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG (STEALTH TUNED) ================= */
const START_BAL = Number(process.env.STARTING_CAPITAL || 100000);
const MIN_CONFIDENCE_TO_TRADE = 0.25; // Synced with Stealth Core v53
const TRADE_COOLDOWN_MS = 10000;      // 10s cooldown to prevent Render flooding
const EXPLORATION_RATE = 0.05;        // 5% Chance to "Learn" on new patterns

/* ================= STATE ================= */
const BRAIN_STATE = new Map();

function getBrainState(id) {
  const key = String(id || "default");
  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.3,
      edgeMomentum: 0,
      lastTradeTime: 0,
      priceMemory: [],
      regime: "INITIALIZING",
      learningAccuracy: 0.5 // Start at 50%
    });
  }
  return BRAIN_STATE.get(key);
}

/* ================= MARKET REGIME (THE "FEEL") ================= */
function detectMarketRegime(prices) {
  if (prices.length < 20) return "OBSERVING";
  const start = prices[prices.length - 20];
  const end = prices[prices.length - 1];
  const move = (end - start) / start;

  if (Math.abs(move) < 0.001) return "RANGE"; 
  return move > 0 ? "BULL_RUN" : "BEAR_PRESSURE";
}

/* ================= DECISION ================= */
function makeDecision(context = {}) {
  // 🔄 SYNC NOTE: 'paper' is now 'core' in v53 Stealth Core
  const { tenantId, symbol = "BTCUSDT", last, core = {} } = context;
  const brain = getBrainState(tenantId);
  const price = Number(last);
  const now = Date.now();

  if (!price || price <= 0) return { action: "WAIT", confidence: 0 };

  // Update Price Memory
  brain.priceMemory.push(price);
  if (brain.priceMemory.length > 50) brain.priceMemory.shift();
  brain.regime = detectMarketRegime(brain.priceMemory);

  // 🏛️ Strategy Layer
  let strategy = {};
  try {
    strategy = buildDecision({
      tenantId,
      symbol,
      price,
      volatility: core.stats?.volatility || 0,
      coreState: core, // Updated name
    }) || {};
  } catch (e) { strategy = { action: "WAIT", confidence: 0.1 }; }

  // 🤖 AI Overlay (The Learning Feed)
  let ai = { confidence: 0, edge: 0 };
  try {
    ai = aiBrain.decide({ tenantId, symbol, last, core }) || {};
  } catch (e) {}

  // 🧪 Weighted Fusion (Confidence & Edge)
  let rawConf = (strategy.confidence || 0.5) * 0.7 + (ai.confidence || 0) * 0.3;
  let rawEdge = (strategy.edge || 0) * 0.7 + (ai.edge || 0) * 0.3;

  // 📉 Smoothing (Confidence Decay)
  brain.smoothedConfidence = (brain.smoothedConfidence * 0.6) + (rawConf * 0.4);
  const finalConfidence = Math.round(brain.smoothedConfidence * 100); // 0-100 scale

  // 🛡️ Execution Logic
  let action = strategy.action || "WAIT";

  // Exploration Mode: If the AI is "Curious," it takes a small Ghost Trade
  if (action === "WAIT" && Math.random() < EXPLORATION_RATE && finalConfidence > 15) {
    action = rawEdge > 0 ? "BUY" : "SELL";
    console.log(`[BRAIN]: Exploration Trade Triggered | Conf: ${finalConfidence}%`);
  }

  // Cooldown & Threshold Check
  if (now - brain.lastTradeTime < TRADE_COOLDOWN_MS) {
    if (action === "BUY" || action === "SELL") action = "WAIT";
  }

  if ((action === "BUY" || action === "SELL") && finalConfidence < (MIN_CONFIDENCE_TO_TRADE * 100)) {
    action = "WAIT";
  }

  if (action === "BUY" || action === "SELL") brain.lastTradeTime = now;

  return {
    symbol,
    action,
    confidence: finalConfidence, // 0-100 for your phone display
    edge: rawEdge,
    regime: brain.regime,
    reason: action === "WAIT" ? "OBSERVING_MARKET" : "STEALTH_ENTRY",
    ts: now
  };
}

module.exports = { makeDecision, getBrainState };
