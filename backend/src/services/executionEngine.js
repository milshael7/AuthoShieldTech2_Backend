// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.0 (SYNCHRONIZED & SLIPPAGE-AWARE)
// FILE: backend/src/services/executionEngine.js
// ==========================================================

const memoryBrain = require("../../brainMemory/memoryBrain");

/* ================= HELPERS ================= */
const safeNum = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const roundMoney = (v) => Number(safeNum(v).toFixed(8));
const roundQty = (qty) => Number(safeNum(qty).toFixed(6));

/* ================= SIMULATION CONFIG ================= */
const FEE_RATE = 0.0006; // 0.06% (Standard Binance/Bybit Fee)
const SLIPPAGE = 0.0002; // 0.02% (Simulated market impact)

/* ================= EXECUTION CORE ================= */
function executePaperOrder({
  tenantId,
  symbol,
  side,       // Changed from 'action' to 'side' to match Route
  price,
  qty,
  stopLoss,
  takeProfit,
  slot = "scalp",
  state,
  ts = Date.now(),
  plan = {},
  decisionMeta = {},
  reason = "SIGNAL",
}) {
  if (!state || !symbol) return null;

  const normalizedSide = String(side || "").toUpperCase();
  const px = safeNum(price);
  if (px <= 0) return null;

  // Ensure State structure
  if (!state.trades) state.trades = [];
  if (!state.decisions) state.decisions = [];
  if (!state.positions) state.positions = { structure: null, scalp: null };

  let pos = state.positions[slot] || state.positions["scalp"];

  /* ================= OPEN POSITION ================= */
  if (normalizedSide === "BUY" || normalizedSide === "SELL") {
    if (pos) return { ok: false, error: "Position already open in this slot" };

    // Apply Slippage to Entry (Buy higher, Sell lower)
    const slipPrice = normalizedSide === "BUY" ? px * (1 + SLIPPAGE) : px * (1 - SLIPPAGE);
    
    const position = {
      symbol,
      side: normalizedSide === "BUY" ? "LONG" : "SHORT",
      entry: roundMoney(slipPrice),
      qty: roundQty(qty || 1),
      time: ts,
      stopLoss: safeNum(stopLoss, null),
      takeProfit: safeNum(takeProfit, null),
      slot,
      confidence: safeNum(decisionMeta.confidence || 0.5),
      capitalUsed: roundMoney(slipPrice * (qty || 1))
    };

    state.positions[slot] = position;
    state.position = position; // Maintain global ref for UI

    // Broadcast
    if (global.broadcastTrade) {
      global.broadcastTrade({ side: normalizedSide, price: slipPrice, time: ts }, tenantId);
    }

    return { ok: true, result: { event: "OPEN", ...position } };
  }

  /* ================= CLOSE POSITION ================= */
  if (normalizedSide === "CLOSE") {
    if (!pos) return { ok: false, error: "No active position to close" };

    // Apply Slippage to Exit
    const exitPrice = pos.side === "LONG" ? px * (1 - SLIPPAGE) : px * (1 + SLIPPAGE);
    
    // PnL Calculation including Simulated Fees
    const grossPnl = pos.side === "LONG" 
      ? (exitPrice - pos.entry) * pos.qty 
      : (pos.entry - exitPrice) * pos.qty;
    
    const fees = (pos.entry * pos.qty * FEE_RATE) + (exitPrice * pos.qty * FEE_RATE);
    const netPnl = roundMoney(grossPnl - fees);

    const tradeRecord = {
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry,
      exit: roundMoney(exitPrice),
      qty: pos.qty,
      pnl: netPnl,
      fees: roundMoney(fees),
      duration: ts - pos.time,
      time: ts,
      reason
    };

    // Store to UI State
    state.trades.push(tradeRecord);
    
    // Store to Permanent Memory
    try {
      memoryBrain.recordTrade({ tenantId, ...tradeRecord, confidence: pos.confidence });
    } catch (e) { console.error("Memory Error", e); }

    // Clear Position
    state.positions[slot] = null;
    if (state.position?.slot === slot) state.position = null;

    if (global.broadcastTrade) {
      global.broadcastTrade({ side: "CLOSE", price: exitPrice, time: ts, pnl: netPnl }, tenantId);
    }

    return { ok: true, result: { event: "CLOSE", ...tradeRecord } };
  }

  return null;
}

module.exports = { executePaperOrder };
