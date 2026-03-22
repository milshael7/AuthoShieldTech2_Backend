// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v31.0 (SINGLE BRAIN — MEMORY CONNECTED)
// MAINTENANCE SAFE — NO SPLIT BRAIN
// ==========================================================

// 🔥 ONLY BRAIN
const memoryBrain = require("../../brainMemory/memoryBrain");

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

/* =========================================================
AI TIMING DEFAULTS
========================================================= */

const MIN_DURATION = 60 * 1000;
const MAX_DURATION = 20 * 60 * 1000;

/* =========================================================
POSITION HELPERS
========================================================= */

function enrichPositionWithTiming(pos, plan = {}) {
  const expectedDuration = clamp(
    safeNum(plan.expectedDuration, 3 * 60 * 1000),
    MIN_DURATION,
    MAX_DURATION
  );

  pos.expectedDuration = expectedDuration;
  pos.timeConfidence = clamp(safeNum(plan.timeConfidence, 0.5), 0, 1);
  pos.exitWindow = expectedDuration * (0.6 + pos.timeConfidence * 0.6);
}

/* =========================================================
STATE HELPERS
========================================================= */

function ensureAnalyticsState(state) {
  if (!state.trades) state.trades = [];
  if (!state.decisions) state.decisions = [];
}

/* =========================================================
EXECUTION CORE
========================================================= */

function executePaperOrder({
  tenantId,
  symbol,
  action,
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

  ensureAnalyticsState(state);

  const normalizedSlot = normalizeSlot(slot);
  const normalizedAction = String(action || "").toUpperCase();
  const px = safeNum(price, 0);

  if (px <= 0) return null;

  if (!state.positions) {
    state.positions = { structure: null, scalp: null };
  }

  let pos = state.positions[normalizedSlot];

  /* =========================================================
  OPEN
  ========================================================= */

  if (normalizedAction === "BUY" || normalizedAction === "SELL") {
    if (pos) return null;

    const side = normalizedAction === "BUY" ? "LONG" : "SHORT";

    const position = {
      symbol,
      side,
      entry: px,
      qty: roundQty(qty || 1),
      capitalUsed: roundMoney(px * (qty || 1)),
      time: ts,
      stopLoss,
      takeProfit,
      slot: normalizedSlot,
      bestPnl: 0,

      // AI CONTEXT
      confidence: safeNum(decisionMeta.confidence, 0),
      pattern: decisionMeta.pattern || "unknown",
      setup: decisionMeta.setup || "unknown",
    };

    enrichPositionWithTiming(position, plan);

    state.positions[normalizedSlot] = position;
    state.position = position;

    // 🔥 STORE DECISION (UI + analytics)
    state.decisions.push({
      action: normalizedAction,
      confidence: position.confidence,
      time: ts,
      symbol,
    });

    // 🔥 BROADCAST
    if (global.broadcastTrade) {
      global.broadcastTrade(
        {
          side: normalizedAction,
          price: px,
          time: ts,
        },
        tenantId
      );
    }

    return {
      ok: true,
      result: {
        event: "OPEN",
        side,
        price: px,
        entry: px,
        qty: position.qty,
        time: ts,
      },
    };
  }

  /* =========================================================
  CLOSE
  ========================================================= */

  if (normalizedAction === "CLOSE") {
    if (!pos) return null;

    const pnl =
      pos.side === "LONG"
        ? (px - pos.entry) * pos.qty
        : (pos.entry - px) * pos.qty;

    const duration = ts - pos.time;

    /* =========================================================
    🔥 RECORD TRADE TO MEMORY BRAIN (ONLY ONCE — SOURCE OF TRUTH)
    ========================================================= */

    try {
      memoryBrain.recordTrade({
        tenantId,
        symbol: pos.symbol,
        entry: pos.entry,
        exit: px,
        qty: pos.qty,
        pnl,
        confidence: pos.confidence || 0,
        edge: 0,
        volatility: 0,
      });
    } catch (err) {
      console.error("Memory brain error:", err.message);
    }

    /* =========================================================
    STORE TRADE (LOCAL STATE FOR UI)
    ========================================================= */

    state.trades.push({
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry,
      exit: px,
      qty: pos.qty,
      pnl,
      win: pnl > 0,
      duration,
      confidence: pos.confidence || 0,
      time: ts,
    });

    /* =========================================================
    RESET
    ========================================================= */

    state.positions[normalizedSlot] = null;
    state.position = null;

    /* =========================================================
    BROADCAST
    ========================================================= */

    if (global.broadcastTrade) {
      global.broadcastTrade(
        {
          side: reason,
          price: px,
          time: ts,
          pnl,
        },
        tenantId
      );
    }

    return {
      ok: true,
      result: {
        event: "CLOSE",
        reason,
        price: px,
        exit: px,
        pnl,
        qty: pos.qty,
        duration,
        expectedDuration: pos.expectedDuration,
        timeEfficiency: duration / pos.expectedDuration,
        time: ts,
      },
    };
  }

  return null;
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  executePaperOrder,
};
