// ==========================================================
// 🔒 AUTOSHIELD BRAIN — v6.1 (HIGH-ACTIVITY & REPORTING)
// FILE: backend/src/engine/engineCore.js
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
// Note: memoryBrain is used for long-term pattern storage
const memoryBrain = require("../../brainMemory/memoryBrain");

/* ================= STATE MANAGEMENT ================= */
const ENGINE_STATE = new Map();

/**
 * Enhanced State: Now includes 'velocity' and 'confidence' for the UI
 */
function getState(tenantId) {
  const key = String(tenantId || "__default__");
  if (!ENGINE_STATE.has(key)) {
    ENGINE_STATE.set(key, {
      positions: { scalp: null, structure: null },
      trades: [],
      decisions: [],
      priceHistory: [], 
      metrics: {
        confidence: 0,
        velocity: 0,
        memoryUsage: 0
      },
      executionStats: { ticks: 0, decisions: 0, trades: 0 }
    });
  }
  return ENGINE_STATE.get(key);
}

/* ================= 🧠 AI DECISION LOGIC ================= */
function getDecision(state, price) {
  // 1. Update Memory (Increase to 50 for better pattern recognition)
  state.priceHistory.push(Number(price));
  if (state.priceHistory.length > 50) state.priceHistory.shift();

  // Update UI Metric: Memory Usage
  state.metrics.memoryUsage = Math.round((state.priceHistory.length / 50) * 100);

  // 2. Need at least 5 ticks to calculate "Velocity"
  if (state.priceHistory.length < 5) {
    state.metrics.confidence = 0;
    state.metrics.velocity = 0;
    return { side: "WAIT", confidence: 0 };
  }

  const last = state.priceHistory[state.priceHistory.length - 1];
  const prev = state.priceHistory[state.priceHistory.length - 2];
  const start = state.priceHistory[0];

  // Calculate Velocity (Direction of the last 5 ticks)
  const velocity = ((last - start) / start) * 1000;
  state.metrics.velocity = Number(velocity.toFixed(4));

  // 3. DECISION AGGRESSION (Lowered threshold for High-Activity)
  let side = "WAIT";
  let confidence = Math.abs(velocity) * 10; // Scaling velocity to confidence

  if (velocity > 0.02) side = "BUY";
  if (velocity < -0.02) side = "SELL";

  // Cap confidence for the UI
  state.metrics.confidence = Math.min(Math.round(confidence * 100), 100);

  return { side, confidence: state.metrics.confidence / 100 };
}

/* ================= 🛡️ RISK MONITOR ================= */
function checkRisk(pos, price) {
  if (!pos) return null;
  const px = Number(price);
  
  if (pos.side === "BUY" || pos.side === "LONG") {
    if (pos.stopLoss && px <= pos.stopLoss) return "STOP_LOSS";
    if (pos.takeProfit && px >= pos.takeProfit) return "TAKE_PROFIT";
  } else {
    if (pos.stopLoss && px >= pos.stopLoss) return "STOP_LOSS";
    if (pos.takeProfit && px <= pos.takeProfit) return "TAKE_PROFIT";
  }
  return null;
}

/* ================= ⚡ ENGINE HEARTBEAT ================= */
function processTick({ tenantId, symbol, price, ts = Date.now() }) {
  if (!tenantId || !price) return null;
  
  const state = getState(tenantId);
  state.executionStats.ticks++;

  /* 1. CHECK ACTIVE POSITIONS (Auto-Exit) */
  const currentPos = state.positions.scalp;
  if (currentPos) {
    const exitReason = checkRisk(currentPos, price);
    if (exitReason) {
      console.log(`🎯 [${tenantId}] EXIT TRIGGERED: ${exitReason} @ ${price}`);
      return executePaperOrder({
        tenantId,
        symbol,
        side: "CLOSE",
        price,
        state,
        ts,
        reason: exitReason
      });
    }
    // Continue processing if no exit, but don't open new trades
    return null; 
  }

  /* 2. GENERATE AI SIGNAL */
  const decision = getDecision(state, price);
  
  // Update Global Stats for Dashboard
  if (decision.side !== "WAIT") {
    state.executionStats.decisions++;
    
    console.log(`🧠 [${tenantId}] AI DECISION: ${decision.side} (Conf: ${state.metrics.confidence}%)`);

    // Record to persistent Brain Memory
    try {
      memoryBrain.recordSignal({
        tenantId,
        symbol,
        action: decision.side,
        confidence: decision.confidence,
        price,
        ts
      });
    } catch (e) { /* Silent fail for memoryBrain */ }

    /* 3. EXECUTE NEW TRADE */
    // Using 1% SL/TP for fast scalp turnover
    const res = executePaperOrder({
      tenantId,
      symbol,
      side: decision.side,
      price,
      qty: 0.1, 
      stopLoss: decision.side === "BUY" ? price * 0.995 : price * 1.005,
      takeProfit: decision.side === "BUY" ? price * 1.01 : price * 0.99,
      state,
      ts,
      decisionMeta: decision
    });

    if (res?.ok) {
      state.executionStats.trades++;
      state.positions.scalp = res.trade; // Set local state position
    }
    return res;
  }

  return null;
}

module.exports = { processTick, getState };
