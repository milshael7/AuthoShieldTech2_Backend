// ==========================================================
// 🔒 PROTECTED CORE FILE — MAINTENANCE SAFE
// ENGINE CORE v4.1 (AI CONNECTED + DEBUG + SAFE)
// ==========================================================
//
// PURPOSE:
// - Orchestrates market → decision → execution → state
// - Connects AI brain properly
//
// RULES:
// - NO hidden mutations
// - ALL decisions tracked
// - FAIL SAFE on bad data
// - DEBUG friendly
//
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
const { updatePrice } = require("./stateStore");
const aiBrain = require("../brain/aiBrain");

/* =========================================================
STATE
========================================================= */

const ENGINE_STATE = new Map();

function getState(tenantId) {
  const key = String(tenantId || "__default__");

  if (!ENGINE_STATE.has(key)) {
    ENGINE_STATE.set(key, {
      positions: { scalp: null },
      trades: [],
      decisions: [],
      executionStats: {
        ticks: 0,
        decisions: 0,
        trades: 0,
      },
    });
  }

  return ENGINE_STATE.get(key);
}

/* =========================================================
UTIL
========================================================= */

function isValidNumber(n) {
  return Number.isFinite(Number(n));
}

/* =========================================================
BASE SIGNAL (NOT AI)
========================================================= */

const PRICE_MEMORY = new Map();

function getMemory(tenantId) {
  const key = String(tenantId || "__default__");

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  return PRICE_MEMORY.get(key);
}

function generateSignal(tenantId, price) {
  const mem = getMemory(tenantId);

  mem.push(price);
  if (mem.length > 5) mem.shift();

  if (mem.length < 3) {
    return { action: "WAIT", confidence: 0 };
  }

  const last = mem[mem.length - 1];
  const prev = mem[mem.length - 2];

  if (last > prev) return { action: "BUY", confidence: 0.55 };
  if (last < prev) return { action: "SELL", confidence: 0.55 };

  return { action: "WAIT", confidence: 0 };
}

/* =========================================================
CLOSE LOGIC
========================================================= */

function checkClose(position, price) {
  if (!position) return null;

  if (!isValidNumber(price)) return null;

  if (position.side === "LONG") {
    if (price <= position.stopLoss) return "STOP_LOSS";
    if (price >= position.takeProfit) return "TAKE_PROFIT";
  }

  if (position.side === "SHORT") {
    if (price >= position.stopLoss) return "STOP_LOSS";
    if (price <= position.takeProfit) return "TAKE_PROFIT";
  }

  return null;
}

/* =========================================================
ENGINE TICK
========================================================= */

function processTick({ tenantId, symbol, price, ts = Date.now() }) {
  try {
    if (!tenantId || !symbol || !isValidNumber(price)) {
      return null; // HARD FAIL SAFE
    }

    const state = getState(tenantId);

    /* ================= TRACK ================= */
    state.executionStats.ticks++;

    /* ================= PRICE ================= */
    updatePrice(tenantId, symbol, price);

    const currentPos = state.positions.scalp;

    /* =========================================================
    CLOSE POSITION
    ========================================================= */

    if (currentPos) {
      const reason = checkClose(currentPos, price);

      if (reason) {
        const res = executePaperOrder({
          tenantId,
          symbol,
          action: "CLOSE",
          price,
          state,
          ts,
          reason,
        });

        if (res?.result) {
          state.executionStats.trades++;

          state.trades.push({
            type: "CLOSE",
            reason,
            price,
            pnl: res.result.pnl,
            time: ts,
          });

          broadcast({
            tenantId,
            side: reason,
            price,
            pnl: res.result.pnl,
            time: ts,
          });
        }

        return;
      }
    }

    /* =========================================================
    BASE SIGNAL (RAW)
    ========================================================= */

    const base = generateSignal(tenantId, price);

    if (base.action === "WAIT") return;
    if (state.positions.scalp) return;

    /* =========================================================
    AI DECISION LAYER
    ========================================================= */

    const ai = aiBrain.decide({
      tenantId,
      symbol,
      last: price,
      paper: state,
      baseConfidence: base.confidence,
      baseEdge: 0,
      pattern: "momentum",
      setup: "micro_trend",
    });

    // 🔒 FAIL SAFE
    if (!ai || !isValidNumber(ai.confidence)) return;

    /* ================= FILTER ================= */

    if (ai.confidence < 0.55) {
      return; // AI rejects weak setup
    }

    /* ================= TRACK DECISION ================= */

    state.executionStats.decisions++;

    state.decisions.push({
      action: base.action,
      confidence: ai.confidence,
      regime: ai.regime,
      time: ts,
    });

    // prevent memory explosion
    if (state.decisions.length > 500) {
      state.decisions.shift();
    }

    /* =========================================================
    EXECUTE TRADE
    ========================================================= */

    const res = executePaperOrder({
      tenantId,
      symbol,
      action: base.action,
      price,
      qty: 0.01,
      stopLoss:
        base.action === "BUY"
          ? price * 0.995
          : price * 1.005,
      takeProfit:
        base.action === "BUY"
          ? price * 1.005
          : price * 0.995,
      state,
      ts,
      decisionMeta: {
        confidence: ai.confidence,
        pattern: "momentum",
        setup: "micro_trend",
      },
    });

    if (res?.result) {
      state.executionStats.trades++;

      state.trades.push({
        type: "OPEN",
        side: base.action,
        price,
        confidence: ai.confidence,
        time: ts,
      });

      broadcast({
        tenantId,
        side: base.action,
        price,
        time: ts,
      });
    }

    return {
      base,
      ai,
      result: res,
    };

  } catch (err) {
    console.error("ENGINE ERROR:", err.message);
    return null;
  }
}

/* =========================================================
SAFE BROADCAST WRAPPER
========================================================= */

function broadcast(data) {
  try {
    if (global.broadcastTrade) {
      global.broadcastTrade(data, data.tenantId);
    }
  } catch {}
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  processTick,
  getState,
};
