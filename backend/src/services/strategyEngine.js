// ==========================================================
// 🔒 STEALTH VISION — v20.0 (SENSITIVE ALIGNMENT & SYNC)
// Replacement for: backend/src/services/strategyEngine.js
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const safe = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

/* ================= CONFIG (STEALTH TUNED) ================= */
const BASE_RISK = 0.02;         // 2% per trade
const STEALTH_THRESHOLD = 0.25; // Synced with Stealth Brain v26.0
const MEMORY = new Map();

/* ================= TREND & MOMENTUM ================= */

function updateMemory(id, price) {
  const key = String(id || "default");
  if (!MEMORY.has(key)) MEMORY.set(key, []);
  const arr = MEMORY.get(key);
  arr.push(price);
  if (arr.length > 100) arr.shift(); // Lean memory for Render stability
  return arr;
}

function analyzeMarket(prices) {
  if (prices.length < 20) return { trend: "CALIBRATING", momentum: 0 };

  const start = prices[prices.length - 20];
  const end = prices[prices.length - 1];
  const move = (end - start) / start;

  let trend = "SIDEWAYS";
  if (move > 0.0015) trend = "BULLISH";
  if (move < -0.0015) trend = "BEARISH";

  // Momentum check (last 5 ticks)
  const momStart = prices[prices.length - 5];
  const momentum = (end - momStart) / momStart;

  return { trend, momentum, move };
}

/* ================= ALIGNMENT (THE "EYES") ================= */

function getAlignmentScore({ trend, momentum }) {
  let score = 0.15; // Baseline "Market Awareness"

  if (trend === "BULLISH" && momentum > 0) score += 0.45;
  if (trend === "BEARISH" && momentum < 0) score += 0.45;
  
  // Reversal detection (Counter-trend momentum)
  if (trend === "BULLISH" && momentum < -0.0002) score += 0.2; 
  if (trend === "BEARISH" && momentum > 0.0002) score += 0.2;

  return clamp(score, 0, 1);
}

/* ================= DECISION ================= */

function buildDecision(ctx = {}) {
  const { tenantId, symbol = "BTCUSDT", price } = ctx;
  const px = safe(price, NaN);

  if (!Number.isFinite(px)) return { action: "WAIT", confidence: 0 };

  const prices = updateMemory(tenantId, px);
  const { trend, momentum } = analyzeMarket(prices);
  const alignment = getAlignmentScore({ trend, momentum });

  let action = "WAIT";
  
  // Entry Logic
  if (alignment >= STEALTH_THRESHOLD) {
    if (momentum > 0) action = "BUY";
    if (momentum < 0) action = "SELL";
  }

  // Risk & Levels
  const riskAmount = px * 0.005; // 0.5% dynamic SL
  const stopLoss = action === "BUY" ? px - riskAmount : px + riskAmount;
  const takeProfit = action === "BUY" ? px + (riskAmount * 2) : px - (riskAmount * 2);

  return {
    symbol,
    action,
    confidence: alignment, 
    edge: momentum,
    riskPct: BASE_RISK * alignment,
    stopLoss,
    takeProfit,
    regime: trend,
    reason: action === "WAIT" ? "WAITING_FOR_ALIGNMENT" : "STEALTH_CONFIRMED",
    ts: Date.now(),
  };
}

module.exports = { buildDecision };
