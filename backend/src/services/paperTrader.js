// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v26.0 (Deterministic + Risk-Based + Realistic Fills)
// ==========================================================

const outsideBrain = require("../../brain/aiBrain");

/* =========================================================
OPTIONAL AXIOS LOAD
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

function roundMoney(v) {
  return Number(safeNum(v, 0).toFixed(8));
}

function normalizeSlot(slot) {
  const s = String(slot || "").toLowerCase();
  return s === "structure" ? "structure" : "scalp";
}

function epsilonEq(a, b, eps = 0.000001) {
  return Math.abs(safeNum(a, 0) - safeNum(b, 0)) <= eps;
}

function ensureTradeLog(state) {
  if (!Array.isArray(state.trades)) {
    state.trades = [];
  }
}

function ensureRealized(state) {
  if (!state.realized || typeof state.realized !== "object") {
    state.realized = { wins: 0, losses: 0, net: 0, fees: 0 };
  }

  state.realized.wins = safeNum(state.realized.wins, 0);
  state.realized.losses = safeNum(state.realized.losses, 0);
  state.realized.net = safeNum(state.realized.net, 0);
  state.realized.fees = safeNum(state.realized.fees, 0);
}

function ensurePositionsShape(state) {
  if (!state.positions || typeof state.positions !== "object") {
    state.positions = {
      structure: null,
      scalp: null,
    };
  }

  if (!("structure" in state.positions)) {
    state.positions.structure = null;
  }

  if (!("scalp" in state.positions)) {
    state.positions.scalp = null;
  }

  // backward compatibility:
  // if legacy state.position exists, move it into scalp if both empty
  if (
    state.position &&
    !state.positions.structure &&
    !state.positions.scalp
  ) {
    state.positions.scalp = state.position;
  }

  state.position =
    state.positions.structure ||
    state.positions.scalp ||
    null;
}

function getOpenPositions(state) {
  ensurePositionsShape(state);

  return ["structure", "scalp"]
    .map((slot) => ({ slot, pos: state.positions[slot] }))
    .filter((x) => !!x.pos);
}

function getPosition(state, slot) {
  ensurePositionsShape(state);
  return state.positions[normalizeSlot(slot)] || null;
}

function setPosition(state, slot, value) {
  ensurePositionsShape(state);
  state.positions[normalizeSlot(slot)] = value || null;
  state.position =
    state.positions.structure ||
    state.positions.scalp ||
    null;
}

function ensureBalances(state) {
  if (!state || typeof state !== "object") return;

  ensurePositionsShape(state);

  const cash = safeNum(state.cashBalance, 0);
  const available = safeNum(state.availableCapital, NaN);
  const locked = safeNum(state.lockedCapital, NaN);

  if (!Number.isFinite(available) && !Number.isFinite(locked)) {
    state.availableCapital = cash;
    state.lockedCapital = 0;
  } else if (!Number.isFinite(available)) {
    state.lockedCapital = Math.max(0, locked);
    state.availableCapital = Math.max(0, cash - state.lockedCapital);
  } else if (!Number.isFinite(locked)) {
    state.availableCapital = Math.max(0, available);
    state.lockedCapital = Math.max(0, cash - state.availableCapital);
  } else {
    state.availableCapital = Math.max(0, available);
    state.lockedCapital = Math.max(0, locked);
  }

  state.cashBalance = roundMoney(state.availableCapital + state.lockedCapital);
}

function ensurePositionRuntime(position, slot = "scalp") {
  if (!position || typeof position !== "object") return;

  position.slot = normalizeSlot(position.slot || slot);
  position.qty = roundQty(position.qty);
  position.entry = safeNum(position.entry, 0);
  position.capitalUsed = roundMoney(safeNum(position.capitalUsed, 0));
  position.time = safeNum(position.time, Date.now());
  position.peakProfit = safeNum(position.peakProfit, 0);
  position.pyramidCount = safeNum(position.pyramidCount, 0);
  position.openFee = roundMoney(safeNum(position.openFee, 0));

  if (!Number.isFinite(position.stopLoss)) {
    position.stopLoss = null;
  }

  if (!Number.isFinite(position.takeProfit)) {
    position.takeProfit = null;
  }
}

function ensureMarketState(state) {
  if (!state.lastPriceBySymbol || typeof state.lastPriceBySymbol !== "object") {
    state.lastPriceBySymbol = {};
  }
}

function assertStateInvariants(state) {
  ensureBalances(state);
  ensurePositionsShape(state);
  ensureTradeLog(state);
  ensureRealized(state);

  if (state.availableCapital < -0.000001) {
    throw new Error("Invariant failed: availableCapital < 0");
  }

  if (state.lockedCapital < -0.000001) {
    throw new Error("Invariant failed: lockedCapital < 0");
  }

  const expectedCash = roundMoney(state.availableCapital + state.lockedCapital);
  if (!epsilonEq(expectedCash, state.cashBalance, 0.00001)) {
    state.cashBalance = expectedCash;
  }

  for (const { slot, pos } of getOpenPositions(state)) {
    ensurePositionRuntime(pos, slot);

    if (pos.qty <= 0) {
      throw new Error(`Invariant failed: non-positive qty in slot ${slot}`);
    }

    if (pos.entry <= 0) {
      throw new Error(`Invariant failed: non-positive entry in slot ${slot}`);
    }

    if (pos.capitalUsed < 0) {
      throw new Error(`Invariant failed: negative capitalUsed in slot ${slot}`);
    }
  }
}

function syncAccountState(state, markPrices = {}) {
  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);
  ensureMarketState(state);

  let lockedCapital = 0;
  let unrealized = 0;

  for (const { slot, pos } of getOpenPositions(state)) {
    ensurePositionRuntime(pos, slot);

    lockedCapital += Math.max(0, safeNum(pos.capitalUsed, 0));

    const explicitMark = safeNum(markPrices?.[pos.symbol], NaN);
    const fallbackLast =
      safeNum(state.lastPriceBySymbol?.[pos.symbol], NaN) > 0
        ? safeNum(state.lastPriceBySymbol[pos.symbol], NaN)
        : safeNum(state.lastPrice, NaN);

    const price =
      Number.isFinite(explicitMark) && explicitMark > 0
        ? explicitMark
        : fallbackLast;

    if (price > 0) {
      const grossPnl =
        pos.side === "LONG"
          ? (price - pos.entry) * pos.qty
          : (pos.entry - price) * pos.qty;

      unrealized += grossPnl;
    }
  }

  state.lockedCapital = roundMoney(Math.max(0, lockedCapital));
  state.availableCapital = roundMoney(
    Math.max(0, safeNum(state.cashBalance, 0) - state.lockedCapital)
  );
  state.equity = roundMoney(safeNum(state.cashBalance, 0) + unrealized);

  if (!Number.isFinite(state.peakEquity)) {
    state.peakEquity = state.equity;
  } else {
    state.peakEquity = roundMoney(
      Math.max(safeNum(state.peakEquity, state.equity), state.equity)
    );
  }

  state.position =
    state.positions.structure ||
    state.positions.scalp ||
    null;

  assertStateInvariants(state);
}

function applyRealizedPnl(state, pnl, fees = 0) {
  ensureRealized(state);

  pnl = roundMoney(safeNum(pnl, 0));
  fees = roundMoney(safeNum(fees, 0));

  if (pnl > 0) state.realized.wins += 1;
  else if (pnl < 0) state.realized.losses += 1;

  state.realized.net = roundMoney(state.realized.net + pnl);
  state.realized.fees = roundMoney(state.realized.fees + fees);
}

/* =========================================================
RISK CONFIGURATION
Synthetic margin model:
- LONG and SHORT both reserve notional capital in paper mode
- capitalUsed represents reserved margin/notional budget
- this keeps ledger deterministic and capital-constrained
========================================================= */

const MAX_EQUITY_EXPOSURE = 0.03;
const HARD_ACCOUNT_RISK = 0.015;
const MAX_TRADE_USD = 1500;
const MIN_TRADE_USD = 100;

const SLOT_CAPITAL_LIMITS = {
  structure: 0.02,
  scalp: 0.01,
};

const MAX_PYRAMIDS = 2;
const PYRAMID_TRIGGER_PNL = 0.003;
const PYRAMID_SIZE_FACTOR = 0.35;

/* =========================================================
EXECUTION REALISM
========================================================= */

const DEFAULT_FEES_BPS = 5;      // 0.05%
const DEFAULT_SLIPPAGE_BPS = 3;  // 0.03%
const DEFAULT_SPREAD_BPS = 2;    // 0.02%

function getExecutionConfig(state, symbol) {
  const globalConfig = state?.executionConfig || {};
  const bySymbol = globalConfig.bySymbol?.[symbol] || {};

  const feeBps = clamp(
    safeNum(bySymbol.feeBps, globalConfig.feeBps ?? DEFAULT_FEES_BPS),
    0,
    100
  );

  const slippageBps = clamp(
    safeNum(bySymbol.slippageBps, globalConfig.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
    0,
    500
  );

  const spreadBps = clamp(
    safeNum(bySymbol.spreadBps, globalConfig.spreadBps ?? DEFAULT_SPREAD_BPS),
    0,
    500
  );

  return { feeBps, slippageBps, spreadBps };
}

function applyExecutionPriceModel({
  symbol,
  rawPrice,
  side,
  state,
}) {
  const price = safeNum(rawPrice, 0);
  if (price <= 0) return 0;

  const { slippageBps, spreadBps } = getExecutionConfig(state, symbol);

  const spreadHalf = price * (spreadBps / 10000) * 0.5;
  const slippage = price * (slippageBps / 10000);

  if (side === "BUY") {
    return roundMoney(price + spreadHalf + slippage);
  }

  if (side === "SELL") {
    return roundMoney(price - spreadHalf - slippage);
  }

  return roundMoney(price);
}

function calculateFee({
  symbol,
  notional,
  state,
}) {
  const { feeBps } = getExecutionConfig(state, symbol);
  return roundMoney(safeNum(notional, 0) * (feeBps / 10000));
}

/* =========================================================
EXECUTION COOLDOWN
FIX: Use event time, not wall clock
========================================================= */

const EXECUTION_COOLDOWN_MS = 400;
const LAST_EXECUTION_BY_KEY = new Map();

function executionKey(tenantId, symbol, slot) {
  return `${tenantId || "__default__"}:${symbol || "__symbol__"}:${normalizeSlot(slot)}`;
}

function isCoolingDown(tenantId, symbol, slot, eventTs) {
  const key = executionKey(tenantId, symbol, slot);
  const last = safeNum(LAST_EXECUTION_BY_KEY.get(key), 0);
  const now = safeNum(eventTs, 0);

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
FIX: Use stop distance when stopLoss is provided
========================================================= */

function calculatePositionSize(
  state,
  price,
  riskPct,
  confidence = 0.5,
  slot = "scalp",
  stopLoss = null,
  side = "LONG"
) {
  ensureBalances(state);
  ensurePositionsShape(state);

  const normalizedSlot = normalizeSlot(slot);
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

  const slotExposureCap =
    equity * safeNum(SLOT_CAPITAL_LIMITS[normalizedSlot], 0.01);

  const requestedRiskCapital = equity * boundedRiskPct * confidenceScale;
  const exposureCap = equity * MAX_EQUITY_EXPOSURE;
  const hardRiskCap = equity * HARD_ACCOUNT_RISK;

  let allowedNotional = Math.min(
    requestedRiskCapital,
    exposureCap,
    hardRiskCap,
    slotExposureCap,
    MAX_TRADE_USD,
    safeNum(state.availableCapital, 0)
  );

  // Risk sizing by stop distance when SL is valid
  if (Number.isFinite(stopLoss) && stopLoss > 0) {
    const perUnitRisk = Math.abs(price - stopLoss);
    if (perUnitRisk > 0) {
      const riskBudget = Math.min(
        equity * boundedRiskPct * confidenceScale,
        equity * HARD_ACCOUNT_RISK,
        MAX_TRADE_USD
      );

      const riskQty = riskBudget / perUnitRisk;
      const notionalCappedQty = allowedNotional / price;
      const sizedQty = Math.min(riskQty, notionalCappedQty);

      if (sizedQty * price < MIN_TRADE_USD) {
        return 0;
      }

      return roundQty(sizedQty);
    }
  }

  if (allowedNotional < MIN_TRADE_USD) {
    return 0;
  }

  return roundQty(allowedNotional / price);
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
  slot = "scalp",
  ts,
}) {
  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);

  const normalizedSlot = normalizeSlot(slot);
  qty = roundQty(qty);

  if (getPosition(state, normalizedSlot)) return null;
  if (qty <= 0) return null;

  const reservedNotional = roundMoney(qty * price);
  if (reservedNotional <= 0) return null;

  const openFee = calculateFee({
    symbol,
    notional: reservedNotional,
    state,
  });

  const totalRequired = roundMoney(reservedNotional + openFee);
  if (totalRequired > state.availableCapital) return null;

  const sltp = normalizeStopLossTakeProfit({
    side,
    price,
    stopLoss: safeNum(stopLoss, NaN),
    takeProfit: safeNum(takeProfit, NaN),
  });

  // Synthetic margin model:
  // reserve notional + pay fee from available capital immediately
  state.availableCapital = roundMoney(state.availableCapital - totalRequired);
  state.lockedCapital = roundMoney(state.lockedCapital + reservedNotional);
  state.cashBalance = roundMoney(state.cashBalance - openFee);

  const position = {
    slot: normalizedSlot,
    symbol,
    side,
    entry: price,
    qty,
    capitalUsed: reservedNotional,
    openFee,
    time: ts,
    peakProfit: 0,
    pyramidCount: 0,
    stopLoss: sltp.stopLoss,
    takeProfit: sltp.takeProfit,
  };

  ensurePositionRuntime(position, normalizedSlot);
  setPosition(state, normalizedSlot, position);

  const trade = {
    side,
    slot: normalizedSlot,
    symbol,
    entry: price,
    price,
    qty,
    capitalUsed: reservedNotional,
    fee: openFee,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    pnl: 0,
    time: ts,
  };

  state.trades.push(trade);
  applyRealizedPnl(state, 0, openFee);
  syncAccountState(state, { [symbol]: price });

  return {
    ok: true,
    result: trade,
    results: [trade],
  };
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
  slot = "scalp",
  ts,
}) {
  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);

  const normalizedSlot = normalizeSlot(slot);
  const pos = getPosition(state, normalizedSlot);

  if (!pos) return null;
  if (pos.symbol !== symbol) return null;
  if (!allowPyramid(pos, price)) return null;

  qty = roundQty(qty);
  if (qty <= 0) return null;

  const reservedNotional = roundMoney(qty * price);
  const addFee = calculateFee({
    symbol,
    notional: reservedNotional,
    state,
  });

  const totalRequired = roundMoney(reservedNotional + addFee);
  if (totalRequired <= 0 || totalRequired > state.availableCapital) return null;

  const oldQty = pos.qty;
  const newQty = roundQty(oldQty + qty);
  if (newQty <= 0) return null;

  const newEntry = ((pos.entry * oldQty) + (price * qty)) / newQty;

  pos.qty = newQty;
  pos.entry = safeNum(newEntry, price);
  pos.capitalUsed = roundMoney(pos.capitalUsed + reservedNotional);
  pos.openFee = roundMoney(safeNum(pos.openFee, 0) + addFee);
  pos.pyramidCount = safeNum(pos.pyramidCount, 0) + 1;

  state.availableCapital = roundMoney(state.availableCapital - totalRequired);
  state.lockedCapital = roundMoney(state.lockedCapital + reservedNotional);
  state.cashBalance = roundMoney(state.cashBalance - addFee);

  const trade = {
    side: "ADD",
    slot: normalizedSlot,
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty,
    capitalUsed: reservedNotional,
    fee: addFee,
    time: ts,
  };

  state.trades.push(trade);
  applyRealizedPnl(state, 0, addFee);
  syncAccountState(state, { [symbol]: price });

  return {
    ok: true,
    result: trade,
    results: [trade],
  };
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
  slot = "scalp",
  ts,
  reason = "PARTIAL_CLOSE",
}) {
  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);

  const normalizedSlot = normalizeSlot(slot);
  const pos = getPosition(state, normalizedSlot);

  if (!pos) return null;
  if (pos.symbol !== symbol) return null;

  closePct = clamp(safeNum(closePct, 0.25), 0.01, 1);

  const originalQty = safeNum(pos.qty, 0);
  if (originalQty <= 0) return null;

  let qtyClose = roundQty(originalQty * closePct);

  if (qtyClose <= 0) return null;
  if (qtyClose > originalQty) qtyClose = originalQty;

  const effectiveClosePct = qtyClose / originalQty;
  const releasedCost = roundMoney(pos.capitalUsed * effectiveClosePct);
  const allocatedOpenFee = roundMoney(safeNum(pos.openFee, 0) * effectiveClosePct);

  let grossPnl = 0;

  if (pos.side === "LONG") {
    grossPnl = (price - pos.entry) * qtyClose;
  } else if (pos.side === "SHORT") {
    grossPnl = (pos.entry - price) * qtyClose;
  }

  const closeNotional = roundMoney(qtyClose * price);
  const closeFee = calculateFee({
    symbol,
    notional: closeNotional,
    state,
  });

  const pnl = roundMoney(grossPnl - closeFee);

  state.lockedCapital = roundMoney(state.lockedCapital - releasedCost);
  state.availableCapital = roundMoney(state.availableCapital + releasedCost + pnl);
  state.cashBalance = roundMoney(state.cashBalance - closeFee + grossPnl);

  pos.qty = roundQty(originalQty - qtyClose);
  pos.capitalUsed = roundMoney(Math.max(0, pos.capitalUsed - releasedCost));
  pos.openFee = roundMoney(Math.max(0, safeNum(pos.openFee, 0) - allocatedOpenFee));
  pos.peakProfit = 0;

  const trade = {
    side: reason,
    slot: normalizedSlot,
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty: qtyClose,
    grossPnl: roundMoney(grossPnl),
    fee: closeFee,
    pnl,
    closePct: effectiveClosePct,
    time: ts,
  };

  state.trades.push(trade);
  applyRealizedPnl(state, pnl, closeFee);

  if (pos.qty <= 0.000001 || pos.capitalUsed <= 0.01) {
    setPosition(state, normalizedSlot, null);
  } else {
    ensurePositionRuntime(pos, normalizedSlot);
  }

  try {
    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl,
      slot: normalizedSlot,
      symbol,
      reason,
    });
  } catch (err) {
    console.error("AI learning error:", err.message);
  }

  syncAccountState(state, { [symbol]: price });

  return {
    ok: true,
    result: trade,
    results: [trade],
  };
}

/* =========================================================
FULL CLOSE
========================================================= */

function closePosition({
  tenantId,
  state,
  symbol,
  price,
  slot = "scalp",
  ts,
  reason = "CLOSE",
}) {
  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);

  const normalizedSlot = normalizeSlot(slot);
  const pos = getPosition(state, normalizedSlot);

  if (!pos) return null;
  if (pos.symbol !== symbol) return null;

  let grossPnl = 0;

  if (pos.side === "LONG") {
    grossPnl = (price - pos.entry) * pos.qty;
  } else if (pos.side === "SHORT") {
    grossPnl = (pos.entry - price) * pos.qty;
  }

  const closeNotional = roundMoney(pos.qty * price);
  const closeFee = calculateFee({
    symbol,
    notional: closeNotional,
    state,
  });

  const pnl = roundMoney(grossPnl - closeFee);
  const capitalReturn = roundMoney(pos.capitalUsed + pnl);

  state.lockedCapital = roundMoney(state.lockedCapital - pos.capitalUsed);
  state.availableCapital = roundMoney(state.availableCapital + capitalReturn);
  state.cashBalance = roundMoney(state.cashBalance - closeFee + grossPnl);

  const trade = {
    side: reason,
    slot: normalizedSlot,
    symbol: pos.symbol,
    entry: pos.entry,
    price,
    qty: pos.qty,
    grossPnl: roundMoney(grossPnl),
    fee: closeFee,
    pnl,
    duration: ts - pos.time,
    pyramids: safeNum(pos.pyramidCount, 0),
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    time: ts,
  };

  state.trades.push(trade);
  setPosition(state, normalizedSlot, null);

  applyRealizedPnl(state, pnl, closeFee);

  try {
    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl,
      slot: normalizedSlot,
      symbol,
      reason,
    });
  } catch (err) {
    console.error("AI learning error:", err.message);
  }

  syncAccountState(state, { [symbol]: price });

  return {
    ok: true,
    result: trade,
    results: [trade],
  };
}

/* =========================================================
TRIGGER CHECKS
FIX: Can close multiple slots in same tick
========================================================= */

function evaluateProtectiveExit({
  tenantId,
  state,
  symbol,
  price,
  slot = null,
  ts,
}) {
  ensurePositionsShape(state);

  const slots = slot
    ? [normalizeSlot(slot)]
    : ["structure", "scalp"];

  const outputs = [];

  for (const currentSlot of slots) {
    const pos = getPosition(state, currentSlot);

    if (!pos) continue;
    if (pos.symbol !== symbol) continue;

    if (stopLossHit(pos, price)) {
      const result = closePosition({
        tenantId,
        state,
        symbol,
        price,
        slot: currentSlot,
        ts,
        reason: "STOP_LOSS",
      });
      if (result?.result) outputs.push(result.result);
      continue;
    }

    if (takeProfitHit(pos, price)) {
      const result = closePosition({
        tenantId,
        state,
        symbol,
        price,
        slot: currentSlot,
        ts,
        reason: "TAKE_PROFIT",
      });
      if (result?.result) outputs.push(result.result);
    }
  }

  if (outputs.length === 0) return null;

  return {
    ok: true,
    result: outputs[0],
    results: outputs,
  };
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
  slot = "scalp",
  state,
  ts = Date.now(),
}) {
  if (!state) return null;
  if (!symbol) return null;

  ensureTradeLog(state);
  ensureBalances(state);
  ensureRealized(state);
  ensurePositionsShape(state);
  ensureMarketState(state);

  const normalizedSlot = normalizeSlot(slot);
  const rawPrice = safeNum(price, 0);
  if (rawPrice <= 0) return null;

  state.lastPrice = rawPrice;
  state.lastPriceBySymbol[symbol] = rawPrice;

  const normalizedAction = String(action || "").toUpperCase();
  const pos = getPosition(state, normalizedSlot);

  const boundedConfidence = clamp(
    safeNum(confidence, state.lastConfidence || 0.5),
    0,
    1
  );
  state.lastConfidence = boundedConfidence;

  // Protective exits should use executable exit prices,
  // not idealized raw price.
  const worstCaseExitPriceForLong = applyExecutionPriceModel({
    symbol,
    rawPrice,
    side: "SELL",
    state,
  });

  const worstCaseExitPriceForShort = applyExecutionPriceModel({
    symbol,
    rawPrice,
    side: "BUY",
    state,
  });

  const protectiveExit = evaluateProtectiveExit({
    tenantId,
    state,
    symbol,
    price:
      pos?.side === "SHORT"
        ? worstCaseExitPriceForShort
        : worstCaseExitPriceForLong,
    slot: null,
    ts,
  });

  if (protectiveExit) {
    state.lastTradeTime = ts;
    return protectiveExit;
  }

  if (
    ["BUY", "SELL", "ADD", "PARTIAL_CLOSE", "CLOSE", "STOP_LOSS", "TAKE_PROFIT"]
      .includes(normalizedAction)
  ) {
    if (isCoolingDown(tenantId, symbol, normalizedSlot, ts)) {
      return null;
    }
  }

  let positionSize = roundQty(safeNum(qty, 0));

  const orderSideForSizing =
    normalizedAction === "SELL" ? "SHORT" : "LONG";

  let effectiveStopLoss = safeNum(stopLoss, NaN);
  if (!Number.isFinite(effectiveStopLoss)) effectiveStopLoss = null;

  if (positionSize <= 0 && ["BUY", "SELL", "ADD"].includes(normalizedAction)) {
    const executableEntryPrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: normalizedAction === "BUY" ? "BUY" : "SELL",
      state,
    });

    positionSize = calculatePositionSize(
      state,
      executableEntryPrice,
      safeNum(riskPct, 0.01),
      boundedConfidence,
      normalizedSlot,
      effectiveStopLoss,
      orderSideForSizing
    );
  }

  if (normalizedAction === "BUY") {
    if (pos) return null;
    if (positionSize <= 0) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: "BUY",
      state,
    });

    const result = openPosition({
      state,
      symbol,
      price: executablePrice,
      qty: positionSize,
      side: "LONG",
      stopLoss,
      takeProfit,
      slot: normalizedSlot,
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "SELL") {
    if (pos) return null;
    if (positionSize <= 0) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: "SELL",
      state,
    });

    const result = openPosition({
      state,
      symbol,
      price: executablePrice,
      qty: positionSize,
      side: "SHORT",
      stopLoss,
      takeProfit,
      slot: normalizedSlot,
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "ADD") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;
    if (positionSize <= 0) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: pos.side === "LONG" ? "BUY" : "SELL",
      state,
    });

    const result = addToPosition({
      state,
      symbol,
      price: executablePrice,
      qty: roundQty(positionSize * PYRAMID_SIZE_FACTOR),
      slot: normalizedSlot,
      ts,
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "PARTIAL_CLOSE") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: pos.side === "LONG" ? "SELL" : "BUY",
      state,
    });

    const result = partialClosePosition({
      tenantId,
      state,
      symbol,
      price: executablePrice,
      closePct,
      slot: normalizedSlot,
      ts,
      reason: "PARTIAL_CLOSE",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "STOP_LOSS") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: pos.side === "LONG" ? "SELL" : "BUY",
      state,
    });

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price: executablePrice,
      slot: normalizedSlot,
      ts,
      reason: "STOP_LOSS",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "TAKE_PROFIT") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: pos.side === "LONG" ? "SELL" : "BUY",
      state,
    });

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price: executablePrice,
      slot: normalizedSlot,
      ts,
      reason: "TAKE_PROFIT",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (normalizedAction === "CLOSE") {
    if (!pos) return null;
    if (pos.symbol !== symbol) return null;

    const executablePrice = applyExecutionPriceModel({
      symbol,
      rawPrice,
      side: pos.side === "LONG" ? "SELL" : "BUY",
      state,
    });

    const result = closePosition({
      tenantId,
      state,
      symbol,
      price: executablePrice,
      slot: normalizedSlot,
      ts,
      reason: "CLOSE",
    });

    if (result?.result) state.lastTradeTime = ts;
    return result;
  }

  if (
    normalizedAction === "HOLD" ||
    normalizedAction === "WAIT" ||
    normalizedAction === ""
  ) {
    syncAccountState(state, { [symbol]: rawPrice });
    return null;
  }

  return null;
}

/* =========================================================
LIVE EXECUTION
Still a stub. Keeps interface, adds safer request behavior.
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
        timeout: 10000,
        headers: {
          "X-API-KEY": apiKey,
        },
      }
    );

    return {
      ok: true,
      result: {
        side: normalizedAction,
        price: safeNum(price, 0),
        qty: safeNum(qty, 0),
        live: true,
        exchangeId: response.data?.orderId || null,
        raw: response.data || null,
      },
      results: [
        {
          side: normalizedAction,
          price: safeNum(price, 0),
          qty: safeNum(qty, 0),
          live: true,
          exchangeId: response.data?.orderId || null,
        },
      ],
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
