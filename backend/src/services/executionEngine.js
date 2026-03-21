// ==========================================================
// FILE: backend/src/services/executionEngine.js
// VERSION: v29.0 (Broadcast + Smart Close + AI Stable)
// ==========================================================

const outsideBrain = require("../../brain/aiBrain");

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
  reason = "SIGNAL", // 🔥 NEW
}) {
  if (!state || !symbol) return null;

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

    const trade = {
      side: normalizedAction,
      price: px,
      time: ts,
    };

    // 🔥 BROADCAST OPEN
    if (global.broadcastTrade) {
      global.broadcastTrade(trade, tenantId);
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

    /* ================= AI LEARNING ================= */

    try {
      outsideBrain.recordTradeOutcome({
        tenantId,
        symbol: pos.symbol,
        pnl,
        pattern: pos.pattern || "unknown",
        setup: pos.setup || "unknown",
        confidence: pos.confidence || 0,
      });
    } catch (err) {
      console.error("AI record error:", err.message);
    }

    /* ================= RESET ================= */

    state.positions[normalizedSlot] = null;
    state.position = null;

    const trade = {
      side: reason, // 🔥 IMPORTANT
      price: px,
      time: ts,
      pnl,
    };

    // 🔥 BROADCAST CLOSE
    if (global.broadcastTrade) {
      global.broadcastTrade(trade, tenantId);
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
