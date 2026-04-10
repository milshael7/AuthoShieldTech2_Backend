// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.1 (SLIPPAGE & FEE ANALYTICS)
// FILE: backend/src/services/executionEngine.js
// ==========================================================

// 🛰️ PUSH 5.4: Safe import for persistent memory
let memoryBrain = { recordTrade: () => {} };
try {
  memoryBrain = require("../../brainMemory/memoryBrain");
} catch (e) {
  console.warn("[EXEC_ENGINE]: brainMemory module not found, trades will persist in local state only.");
}

/* ================= HELPERS ================= */
const safeNum = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const roundMoney = (v) => Number(safeNum(v).toFixed(8));
const roundQty = (qty) => Number(safeNum(qty).toFixed(6));

/* ================= SIMULATION CONFIG ================= */
const FEE_RATE = 0.0006; // 0.06% Simulated exchange fee
const SLIPPAGE = 0.0002; // 0.02% Simulated market impact

/* ================= EXECUTION CORE ================= */
function executePaperOrder({
  tenantId,
  symbol,
  side,       
  price,
  qty,
  stopLoss,
  takeProfit,
  slot = "scalp",
  state,
  ts = Date.now(),
  decisionMeta = {},
  reason = "SIGNAL",
}) {
  if (!state || !symbol) return { ok: false, error: "MISSING_STATE_OR_SYMBOL" };

  const normalizedSide = String(side || "").toUpperCase();
  const px = safeNum(price);
  if (px <= 0) return { ok: false, error: "INVALID_PRICE" };

  // 🛰️ PUSH 5.4: Hardening State structure for clean UI sync
  if (!state.trades) state.trades = [];
  if (!state.decisions) state.decisions = [];
  if (!state.positions) state.positions = { scalp: null, swing: null };

  let pos = state.positions[slot];

  /* ================= OPEN POSITION ================= */
  if (normalizedSide === "BUY" || normalizedSide === "SELL") {
    if (pos) return { ok: false, error: "SLOT_OCCUPIED" };

    // ENTRY SLIPPAGE: Buy slightly higher, Sell slightly lower
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
    state.position = position; // UI Global reference

    // 📡 Broadcaster Hook (Used by Socket Controller)
    if (global.broadcastTrade) {
      global.broadcastTrade({ 
        event: "ENTRY", 
        side: normalizedSide, 
        price: slipPrice, 
        time: ts,
        slot 
      }, tenantId);
    }

    console.log(`[EXEC]: 🛰️ Node Initialized | ${normalizedSide} at ${slipPrice.toFixed(2)}`);
    return { ok: true, result: { event: "OPEN", ...position } };
  }

  /* ================= CLOSE POSITION ================= */
  if (normalizedSide === "CLOSE") {
    if (!pos) return { ok: false, error: "NO_ACTIVE_POSITION" };

    // EXIT SLIPPAGE: Sell slightly lower, Buy back slightly higher
    const exitPrice = pos.side === "LONG" ? px * (1 - SLIPPAGE) : px * (1 + SLIPPAGE);
    
    // MATH: Gross PnL - (Entry Fee + Exit Fee)
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
      duration: Math.floor((ts - pos.time) / 1000) + "s",
      time: ts,
      reason
    };

    state.trades.push(tradeRecord);
    if (state.trades.length > 100) state.trades.shift(); // Memory management
    
    // PERSISTENCE
    try {
      memoryBrain.recordTrade({ tenantId, ...tradeRecord, confidence: pos.confidence });
    } catch (e) { /* silent fail */ }

    // CLEANUP
    state.positions[slot] = null;
    if (state.position?.slot === slot) state.position = null;

    if (global.broadcastTrade) {
      global.broadcastTrade({ 
        event: "EXIT", 
        price: exitPrice, 
        pnl: netPnl, 
        reason 
      }, tenantId);
    }

    console.log(`[EXEC]: 🛑 Liquidated | PnL: ${netPnl > 0 ? '+' : ''}${netPnl.toFixed(2)} | Reason: ${reason}`);
    return { ok: true, result: { event: "CLOSE", ...tradeRecord } };
  }

  return { ok: false, error: "UNSUPPORTED_ACTION" };
}

module.exports = { executePaperOrder };
