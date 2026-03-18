// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v24.0 (Safe Execution + SL/TP + Symbol Guard)
// ==========================================================

const outsideBrain = require("../../brain/aiBrain");

/* =========================================================
OPTIONAL AXIOS LOAD
- Keeps server from crashing if axios is not installed yet
- Live execution safely returns null until dependency/config exists
========================================================= */
let axios = null;

try {
  axios = require("axios");
} catch {
  axios = null;
}

/* =========================================================
UTIL
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(qty) {
  return Number(safeNum(qty, 0).toFixed(6));
}

function ensureTradeLog(state) {
  if (!Array.isArray(state.trades)) {
    state.trades = [];
  }
}

function ensureBalances(state) {
  if (!state || typeof state !== "object") return;

  if (state.availableCapital === undefined) {
    state.availableCapital = safeNum(state.cashBalance, 0);
  }

  if (state.lockedCapital === undefined) {
    state.lockedCapital = 0;
  }

  if (state.cashBalance === undefined) {
    state.cashBalance =
      safeNum(state.availableCapital, 0) +
      safeNum(state.lockedCapital, 0);
  }

  state.availableCapital = Math.max(0, safeNum(state.availableCapital, 0));
  state.lockedCapital = Math.max(0, safeNum(state.lockedCapital, 0));
  state.cashBalance =
    safeNum(state.availableCapital, 0) +
    safeNum(state.lockedCapital, 0);
}

function ensureRealized(state) {
  if (!state.realized || typeof state.realized !== "object") {
    state.realized = { wins: 0, losses: 0, net: 0 };
  }

  state.realized.wins = safeNum(state.realized.wins, 0);
  state.realized.losses = safeNum(state.realized.losses, 0);
  state.realized.net = safeNum(state.realized.net, 0);
}

function syncAccountState(state) {
  ensureBalances(state);
  ensureRealized(state);

  if (state.position) {
    state.position.qty = roundQty(state.position.qty);
    state.position.capitalUsed = safeNum(state.position.capitalUsed, 0);
    state.position.entry = safeNum(state.position.entry, 0);
  }

  state.cashBalance =
    Math.max(0, safeNum(state.availableCapital, 0)) +
    Math.max(0, safeNum(state.lockedCapital, 0));

  const lastPrice = safeNum(state.lastPrice, 0);

  if (state.position && lastPrice > 0) {
    const pos = state.position;

    const unrealized =
      pos.side === "LONG"
        ? (lastPrice - pos.entry) * pos.qty
        : (pos.entry - lastPrice) * pos.qty;

    state.equity = state.cashBalance + unrealized;
  } else {
    state.equity = state.cashBalance;
  }

  if (!Number.isFinite(state.peakEquity)) {
    state.peakEquity = state.equity;
  } else {
    state.peakEquity = Math.max(state.peakEquity, state.equity);
  }
}

function ensurePositionRuntime(position) {
  if (!position || typeof position !== "object") return;

  position.qty = roundQty(position.qty);
  position.entry = safeNum(position.entry, 0);
  position.capitalUsed = safeNum(position.capitalUsed, 0);
  position.time = safeNum(position.time, Date.now());
  position.peakProfit = safeNum(position.peakProfit, 0);
  position.pyramidCount = safeNum(position.pyramidCount, 0);

  if (!Number.isFinite(position.stopLoss)) {
    position.stopLoss = null;
  }

  if (!Number.isFinite(position.takeProfit)) {
    position.takeProfit = null;
  }
}

/* =========================================================
RISK CONFIGURATION
========================================================= */

const MAX_EQUITY_EXPOSURE = 0.02; // max 2% equity deployed per new trade
const HARD_ACCOUNT_RISK = 0.01;   // hard cap 1% equity sizing gate
const MAX_TRADE_USD = 1000;       // company wanted safer starting paper/live behavior
const MIN_TRADE_USD = 100;

const MAX_PYRAMIDS = 2;
const PYRAMID_TRIGGER_PNL = 0.003;
const PYRAMID_SIZE_FACTOR = 0.35;

/* =========================================================
EXECUTION COOLDOWN
========================================================= */

const EXECUTION_COOLDOWN_MS = 400;
const LAST_EXECUTION_BY_KEY = new Map();

function executionKey(tenantId, symbol) {
  return `${tenantId || "__default__"}:${symbol || "__symbol__"}`;
}

function isCoolingDown(tenantId, symbol, now) {
  const key = executionKey(tenantId, symbol);
  const last = safeNum(LAST_EXECUTION_BY_KEY.get(key), 0);

  if (now - last < EXECUTION_COOLDOWN_MS) {
    return true;
  }

  LAST_EXECUTION_BY_KEY.set(key, now);

  if (LAST_EXECUTION_BY_KEY.size > 5000) {
    const first = LAST_EXECUTION_BY_KEY.keys().next().value;
    if (first) LAST_EXECUTION_BY_KEY.delete(first);
  }

  return false;
}

/* =========================================================
POSITION SIZE
========================================================= */

function calculatePositionSize(state, price, riskPct, confidence = 0.5) {
  ensureBalances(state);

  const equity = safeNum(state.equity, safeNum(state.cashBalance, 0));

  if (equity <= 0 || price <= 0) {
    return 0;
  }

  const boundedRiskPct = clamp(safeNum(riskPct, 0.01), 0.001, 0.05);
  const boundedConfidence = clamp(safeNum(confidence, 0.5), 0, 1);

  let confidenceScale = 1;

  if (boundedConfidence >= 0.9) confidenceScale = 1.15;
  else if (boundedConfidence >= 0.8) confidenceScale = 1.05;
  else if (boundedConfidence < 0.4) confidenceScale = 0.75;

  const requestedRiskCapital = equity * boundedRiskPct * confidenceScale;
  const exposureCap = equity * MAX_EQUITY_EXPOSURE;
  const hardRiskCap = equity * HARD_ACCOUNT_RISK;

  const allowedCapital = Math.min(
    requestedRiskCapital,
    exposureCap,
    hardRiskCap,
    MAX_TRADE_USD,
    safeNum(state.availableCapital, 0)
  );

  if (allowedCapital < MIN_TRADE_USD) {
    return 0;
  }

  return roundQty(allowedCapital / price);
}

/* =========================================================
STOP LOSS / TAKE PROFIT HELPERS
========================================================= */

function normalizeStopLossTakeProfit({ side, price, stopLoss, takeProfit }) {
  const out = {
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
  };

  if (side === "LONG") {
    if (out.stopLoss !== null && out.stopLoss >= price) out.stopLoss = null;
    if (out.takeProfit !== null && out.takeProfit <= price) out.takeProfit = null;
  }

  if (side === "SHORT") {
    if (out.stopLoss !== null && out.stopLoss <= price) out.stopLoss = null;
    if (out.takeProfit !== null && out.takeProfit >= price) out.takeProfit = null;
  }

  return out;
}

function stopLossHit(position, price) {
  if (!position || !Number.isFinite(position.stopLoss)) return false;

  if (position.side === "LONG") {
    return price <= position.stopLoss;
  }

  if (position.side === "SHORT") {
    return price >= position.stopLoss;
  }

  return false;
}

function takeProfitHit(position, price) {
  if (!position || !Number.isFinite(position.takeProfit)) return false;

  if (position.side === "LONG") {
    return price >= position.takeProfit;
  }

  if (position.side === "SHORT") {
    return price <= position.takeProfit;
  }

  return false;
}

/* =========================================================
OPEN POSITION
========================================================= */

function openPosition({
  state,
  symbol,
  price,
  qty,
  side,
  stopLoss = null,
  takeProfit = null,
  ts,
}) {
  ensureTradeLog(state);
  ensureBalances(state);

  qty = roundQty(qty);

  if (qty <= 0) return null;

  const cost = safeNum(qty * price, 0);
  if (cost <= 0) return null;
  if (cost > state.availableCapital) return null;

  const sltp = normalizeStopLossTakeProfit({
    side,
    price,
    stopLoss: safeNum(stopLoss, NaN),
    takeProfit: safeNum(takeProfit, NaN),
  });

  state.availableCapital -= cost;
  state.lockedCapital += cost;

  state.position = {
    symbol,
    side,
    entry: price,
    qty,
    capitalUsed: cost,
    time: ts,
    peakProfit: 0,
    pyramidCount: 0,
    stopLoss: sltp.stopLoss,
    takeProfit: sltp.takeProfit,
  };

  ensurePositionRuntime(state.position);

  const trade = {
    side,
    symbol,
    entry: price,
    price,
    qty,
    capitalUsed: cost,
    stopLoss: state.position.stopLoss,
    takeProfit: state.position.takeProfit,
    pnl: 0,
    time: ts,
  };

  state.trades.push(trade);
  syncAccountState(state);

  return { result: trade };
}

/* =========================================================
ADD TO POSITION
========================================================= */

function allowPyramid(pos, price) {
  if (!pos) return false;
  if ((pos.pyramidCount || 0) >= MAX_PYRAMIDS) return false;

  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry
      : (pos.entry - price) / pos.entry;

  return pnl >= PYRAMID_TRIGGER_PNL;
}

function addToPosition({
  state,
  symbol,
  price,
  qty,
  ts,
}) {
  ensureTradeLog(state);
  ensureBalances(state);

  const pos = state.position;
  if (!pos) return null;
  if (pos.symbol !== symbol) return null;
  if (!allowPyramid(pos, price)) return null;

  qty = roundQty(qty);
  if (qty <= 0) return null;

  const cost = safeNum(qty * price, 0);
  if (cost <= 0 || cost > state.availableCapital) return null;

  const newQty = roundQty(pos.qty + qty);
  if (newQty <= 0) return null;

  const newEntry =
    ((pos.entry * pos.qty) + (price * qty)) / newQty;

  pos.qty = newQty;
  pos.entry = safeNum(newEntry, price);
  pos.capitalUsed += cost;
  pos.pyramidCount = safeNum(pos.pyramidCount, 0) + 1;

  state.availableCapital -= cost;
  state.lockedCapital += cost;

  const trade = {
    side: "ADD",
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty,
    capitalUsed: cost,
    time: ts,
  };

  state.trades.push(trade);
  syncAccountState(state);

  return { result: trade };
}

/* =========================================================
REALIZED TRACKING
========================================================= */

function applyRealizedPnl(state, pnl) {
  ensureRealized(state);

  pnl = safeNum(pnl, 0);

  if (pnl > 0) state.realized.wins += 1;
  else if (pnl < 0) state.realized.losses += 1;

  state.realized.net += pnl;
}

/* =========================================================
PARTIAL CLOSE
========================================================= */

function partialClosePosition({
  tenantId,
  state,
  symbol,
  price,
  closePct,
  ts,
  reason = "PARTIAL_CLOSE",
}) {
  ensureTradeLog(state);
  ensureBalances(state);

  const pos = state.position;
  if (!pos) return null;
  if (pos.symbol !== symbol) return null;

  closePct = clamp(safeNum(closePct, 0.25), 0.01, 1);

  const qtyClose = roundQty(pos.qty * closePct);
  if (qtyClose <= 0) return null;

  const effectiveClosePct = qtyClose / pos.qty;
  const releasedCost = pos.capitalUsed * effectiveClosePct;

  let pnl = 0;

  if (pos.side === "LONG") {
    pnl = (price - pos.entry) * qtyClose;
  } else if (pos.side === "SHORT") {
    pnl = (pos.entry - price) * qtyClose;
  }

  state.lockedCapital -= releasedCost;
  state.availableCapital += releasedCost + pnl;

  pos.qty = roundQty(pos.qty - qtyClose);
  pos.capitalUsed = Math.max(0, pos.capitalUsed - releasedCost);
  pos.peakProfit = 0;

  const trade = {
    side: reason,
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty: qtyClose,
    pnl,
    closePct: effectiveClosePct,
    time: ts,
  };

  state.trades.push(trade);
  applyRealizedPnl(state, pnl);

  if (pos.qty <= 0.000001 || pos.capitalUsed <= 0.01) {
    state.position = null;
  } else {
    ensurePositionRuntime(pos);
  }

  try {
    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl,
    });
  } catch (err) {
    console.error("AI learning error:", err.message);
  }

  syncAccountState(state);

  return { result: trade };
}

/* =========================================================
FULL CLOSE
========================================================= */

function closePosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  reason = "CLOSE",
}) {
  ensureTradeLog(state);
  ensureBalances(state);

  const pos = state.position;
  if (!pos) return null;
  if (pos.symbol !== symbol) return null;

  let pnl = 0;

  if (pos.side === "LONG") {
    pnl = (price - pos.entry) * pos.qty;
  } else if (pos.side === "SHORT") {
    pnl = (pos.entry - price) * pos.qty;
  }

  const capitalReturn = pos.capitalUsed + pnl;

  state.lockedCapital -= pos.capitalUsed;
  state.availableCapital += capitalReturn;

  const trade = {
    side: reason,
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty: pos.qty,
    pnl,
    duration: ts - pos.time,
    pyramids: safeNum(pos.pyramidCount, 0),
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    time: ts,
  };

  state.trades.push(trade);
  state.position = null;

  applyRealizedPnl(state, pnl);

  try {
    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl,
    });
  } catch (err) {
    console.error("AI learning error:", err.message);
  }

  syncAccountState(state);

  return { result: trade };
}

/* =========================================================
TRIGGER CHECKS
- Lets caller send HOLD/WAIT and still have SL/TP protection
========================================================= */

function evaluateProtectiveExit({
  tenantId,
  state,
  symbol,
  price,
  ts,
}) {
  const pos = state.position;
  if (!pos) return null;
  if (pos.symbol !== symbol) return null;

  if (stopLossHit(pos, price)) {
    return closePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "STOP_LOSS",
    });
  }

  if (takeProfitHit(pos, price)) {
    return closePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "TAKE_PROFIT",
    });
  }

  return null;
}

/* =========================================================
PAPER EXECUTION
========================================================= */

function executePaperOrder({
  tenantId,
  symbol,
  action,
  price,
  riskPct,
  confidence,
  qty,
  closePct,
  stopLoss,
  takeProfit,
  state,
  ts = Date.now(),
}) {
  if (!state) return null;
  if (!symbol) return null;

  ensureTradeLog(state);
  ensureBalances(state);

  price = safeNum(price, 0);
  if (price <= 0) return null;

  state.lastPrice = price;

  const now = Date.now();
  const normalizedAction = String(action || "").toUpperCase();
  const pos = state.position || null;

  if (["BUY", "SELL", "ADD", "PARTIAL_CLOSE", "CLOSE"].includes(normalizedAction)) {
    if (isCoolingDown(tenantId, symbol, now)) {
      return null;
    }
  }

  const boundedConfidence = clamp(safeNum(confidence, state.lastConfidence || 0.5), 0, 1);
  state.lastConfidence = boundedConfidence;

  const protectiveExit = evaluateProtectiveExit({
    tenantId,
    state,
    symbol,
    price,
    ts,
  });

  if (protectiveExit) {
    state.lastTradeTime = ts;
    return protectiveExit;
  }

  let positionSize = roundQty(safeNum(qty, 0));

  if (positionSize <= 0) {
    positionSize = calculatePositionSize(
      state,
      price,
      safeNum(riskPct, 0.01),
      boundedConfidence
    );
  }

  if (normalizedAction === "BUY") {
    if (pos) return null;
    if (positionSize <= 0) return null;

    const result = openPosition({
      state,
      symbol,
      price,
      qty: positionSize,
      side: "LONG",
      stopLoss,
      takeProfit,
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "SELL") {
    if (pos) return null;
    if (positionSize <= 0) return null;

    const result = openPosition({
      state,
      symbol,
      price,
      qty: positionSize,
      side: "SHORT",
      stopLoss,
      takeProfit,
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "ADD") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;
    if (positionSize <= 0) return null;

    const result = addToPosition({
      state,
      symbol,
      price,
      qty: roundQty(positionSize * PYRAMID_SIZE_FACTOR),
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "PARTIAL_CLOSE") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const result = partialClosePosition({
      tenantId,
      state,
      symbol,
      price,
      closePct,
      ts,
      reason: "PARTIAL_CLOSE",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "STOP_LOSS") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "STOP_LOSS",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "TAKE_PROFIT") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "TAKE_PROFIT",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "CLOSE") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "CLOSE",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "HOLD" || normalizedAction === "WAIT" || normalizedAction === "") {
    syncAccountState(state);
    return null;
  }

  return null;
}

/* =========================================================
LIVE EXECUTION
- Safe placeholder for now
- Prevents app crash if live mode is selected before axios/config is ready
========================================================= */

async function executeLiveOrder({
  symbol,
  action,
  price,
  qty,
}) {
  try {
    if (!axios) {
      console.warn("Live execution unavailable: axios not installed");
      return null;
    }

    const apiKey = process.env.EXCHANGE_API_KEY;
    const secret = process.env.EXCHANGE_SECRET;
    const endpoint = process.env.EXCHANGE_ORDER_ENDPOINT;

    if (!apiKey || !secret || !endpoint) {
      console.warn("Live trading keys or endpoint missing");
      return null;
    }

    const normalizedAction = String(action || "").toUpperCase();

    if (!["BUY", "SELL"].includes(normalizedAction)) {
      return null;
    }

    const response = await axios.post(
      endpoint,
      {
        symbol,
        side: normalizedAction,
        type: "MARKET",
        quantity: safeNum(qty, 0),
      },
      {
        headers: {
          "X-API-KEY": apiKey,
        },
      }
    );

    return {
      result: {
        side: normalizedAction,
        price,
        qty: safeNum(qty, 0),
        live: true,
        exchangeId: response.data?.orderId || null,
      },
    };
  } catch (err) {
    console.error("Live execution failed:", err.message);
    return null;
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  executePaperOrder,
  executeLiveOrder,
};
