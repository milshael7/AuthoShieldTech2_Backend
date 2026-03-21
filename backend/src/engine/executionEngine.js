// ==========================================================
// 🔒 PROTECTED CORE FILE — DO NOT MODIFY WITHOUT AUTHORIZATION
// MODULE: EXECUTION ENGINE (REAL TRADE LOGIC)
// VERSION: v1.0 (DETERMINISTIC EXECUTION)
//
// PURPOSE:
// - Handles ALL trade execution
// - Enforces stop loss / take profit
// - Updates state via stateStore ONLY
//
// RULES:
// 1. ALL trades MUST go through this engine
// 2. NO direct state mutation outside stateStore
// 3. STOP LOSS and TAKE PROFIT must ALWAYS be respected
// 4. NO UI-based execution (this is backend truth)
//
// ==========================================================

const {
  getState,
  applyTradeResult,
} = require("./stateStore");

/* ================= UTIL ================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v) {
  return Number(safeNum(v, 0).toFixed(8));
}

/* ================= POSITION ================= */

function getOpenPosition(state) {
  return state.positions?.scalp || null;
}

function setPosition(state, pos) {
  state.positions.scalp = pos || null;
}

/* ================= OPEN TRADE ================= */

function openTrade({
  tenantId,
  symbol,
  side, // BUY or SELL
  price,
  qty,
  stopLoss,
  takeProfit,
  ts,
}) {
  const state = getState(tenantId);

  if (getOpenPosition(state)) {
    return null; // only one position allowed
  }

  const notional = price * qty;

  if (notional > state.availableCapital) {
    return null;
  }

  // Reserve capital
  state.availableCapital -= notional;
  state.lockedCapital += notional;

  const position = {
    symbol,
    side: side === "BUY" ? "LONG" : "SHORT",
    entry: price,
    qty,
    stopLoss: safeNum(stopLoss, null),
    takeProfit: safeNum(takeProfit, null),
    time: ts,
  };

  setPosition(state, position);

  return {
    type: "OPEN",
    position,
  };
}

/* ================= CLOSE TRADE ================= */

function closeTrade({
  tenantId,
  price,
  reason = "CLOSE",
  ts,
}) {
  const state = getState(tenantId);
  const pos = getOpenPosition(state);

  if (!pos) return null;

  let pnl = 0;

  if (pos.side === "LONG") {
    pnl = (price - pos.entry) * pos.qty;
  } else {
    pnl = (pos.entry - price) * pos.qty;
  }

  const capitalUsed = pos.entry * pos.qty;

  // Release capital
  state.lockedCapital -= capitalUsed;
  state.availableCapital += capitalUsed + pnl;
  state.cashBalance += pnl;

  const trade = {
    symbol: pos.symbol,
    side: reason,
    entry: pos.entry,
    exit: price,
    qty: pos.qty,
    pnl: round(pnl),
    time: ts,
  };

  setPosition(state, null);

  applyTradeResult(tenantId, trade);

  return trade;
}

/* ================= STOP LOSS / TP CHECK ================= */

function checkStops({
  tenantId,
  price,
  ts,
}) {
  const state = getState(tenantId);
  const pos = getOpenPosition(state);

  if (!pos) return null;

  // STOP LOSS
  if (
    pos.stopLoss !== null &&
    (
      (pos.side === "LONG" && price <= pos.stopLoss) ||
      (pos.side === "SHORT" && price >= pos.stopLoss)
    )
  ) {
    return closeTrade({
      tenantId,
      price,
      reason: "STOP_LOSS",
      ts,
    });
  }

  // TAKE PROFIT
  if (
    pos.takeProfit !== null &&
    (
      (pos.side === "LONG" && price >= pos.takeProfit) ||
      (pos.side === "SHORT" && price <= pos.takeProfit)
    )
  ) {
    return closeTrade({
      tenantId,
      price,
      reason: "TAKE_PROFIT",
      ts,
    });
  }

  return null;
}

/* ================= EXECUTE ================= */

function execute({
  tenantId,
  action,
  symbol,
  price,
  qty,
  stopLoss,
  takeProfit,
  ts = Date.now(),
}) {
  // 1. Always check stops first
  const stopResult = checkStops({ tenantId, price, ts });
  if (stopResult) return stopResult;

  // 2. Execute new action
  if (action === "BUY" || action === "SELL") {
    return openTrade({
      tenantId,
      symbol,
      side: action,
      price,
      qty,
      stopLoss,
      takeProfit,
      ts,
    });
  }

  if (action === "CLOSE") {
    return closeTrade({ tenantId, price, ts });
  }

  return null;
}

/* ================= EXPORT ================= */

module.exports = {
  execute,
};
