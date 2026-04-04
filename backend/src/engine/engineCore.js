// ==========================================================
// 🔒 AUTOSHIELD CORE — v6.0 (SYNCHRONIZED & LEAN)
// FILE: backend/src/engine/engineCore.js
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
const memoryBrain = require("../../brainMemory/memoryBrain");

/* ================= STATE MANAGEMENT ================= */
const ENGINE_STATE = new Map();

function getState(tenantId) {
  const key = String(tenantId || "__default__");
  if (!ENGINE_STATE.has(key)) {
    ENGINE_STATE.set(key, {
      positions: { scalp: null, structure: null },
      trades: [],
      decisions: [],
      priceHistory: [], // Consolidated memory
      executionStats: { ticks: 0, decisions: 0, trades: 0 }
    });
  }
  return ENGINE_STATE.get(key);
}

/* ================= 🧠 AI DECISION LOGIC ================= */
function getDecision(state, price) {
  state.priceHistory.push(price);
  if (state.priceHistory.length > 10) state.priceHistory.shift();

  if (state.priceHistory.length < 3) return { side: "WAIT", confidence: 0 };

  const last = state.priceHistory[state.priceHistory.length - 1];
  const prev = state.priceHistory[state.priceHistory.length - 2];

  // Simple Momentum Logic
  if (last > prev) return { side: "BUY", confidence: 0.6, edge: 0.001 };
  if (last < prev) return { side: "SELL", confidence: 0.6, edge: -0.001 };

  return { side: "WAIT", confidence: 0 };
}

/* ================= 🛡️ RISK MONITOR ================= */
function checkRisk(pos, price) {
  if (!pos) return null;
  const px = Number(price);
  
  if (pos.side === "LONG") {
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

  const currentPos = state.positions.scalp;

  /* 1. CHECK AUTO-EXIT (SL/TP) */
  if (currentPos) {
    const exitReason = checkRisk(currentPos, price);
    if (exitReason) {
      // NOTE: executePaperOrder now handles recordTrade and broadcastTrade internally
      return executePaperOrder({
        tenantId,
        symbol,
        side: "CLOSE", // Sync'd to match Engine
        price,
        state,
        ts,
        reason: exitReason
      });
    }
    return null; // Don't look for new trades while one is open
  }

  /* 2. GENERATE AI SIGNAL */
  const decision = getDecision(state, price);
  
  if (decision.side !== "WAIT") {
    state.executionStats.decisions++;
    state.decisions.push({ ...decision, time: ts, symbol });

    // Record signal to permanent brain memory
    try {
      memoryBrain.recordSignal({
        tenantId,
        symbol,
        action: decision.side,
        confidence: decision.confidence,
        price,
        ts
      });
    } catch (e) { console.error("Signal Record Error", e); }

    /* 3. EXECUTE NEW TRADE */
    const res = executePaperOrder({
      tenantId,
      symbol,
      side: decision.side, // Sync'd to match Engine
      price,
      qty: 0.01,
      stopLoss: decision.side === "BUY" ? price * 0.99 : price * 1.01,
      takeProfit: decision.side === "BUY" ? price * 1.02 : price * 0.98,
      state,
      ts,
      decisionMeta: decision
    });

    if (res?.ok) state.executionStats.trades++;
    return res;
  }

  return null;
}

module.exports = { processTick, getState };
