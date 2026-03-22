// ==========================================================
// ENGINE CORE v4.0 (REAL AI CONNECTED — PRODUCTION READY)
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
PRICE MEMORY (BASE SIGNAL)
========================================================= */

const PRICE_MEMORY = new Map();

function getMemory(tenantId) {
  const key = String(tenantId || "__default__");

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  return PRICE_MEMORY.get(key);
}

function simpleSignal(tenantId, price) {
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
  if (!tenantId || !symbol || !price) return null;

  const state = getState(tenantId);

  /* ================= TRACK ================= */
  state.executionStats.ticks++;

  /* ================= PRICE ================= */
  updatePrice(tenantId, symbol, price);

  const currentPos = state.positions.scalp;

  /* =========================================================
  CLOSE
  ========================================================= */

  if (currentPos) {
    const closeReason = checkClose(currentPos, price);

    if (closeReason) {
      const res = executePaperOrder({
        tenantId,
        symbol,
        action: "CLOSE",
        price,
        state,
        ts,
        reason: closeReason,
      });

      if (res?.result) {
        state.executionStats.trades++;

        // 🔥 STORE CLOSED TRADE
        state.trades.push({
          side: closeReason,
          price,
          time: ts,
          pnl: res.result.pnl,
        });

        if (global.broadcastTrade) {
          global.broadcastTrade(
            {
              side: closeReason,
              price,
              time: ts,
              pnl: res.result.pnl,
            },
            tenantId
          );
        }
      }

      return;
    }
  }

  /* =========================================================
  BASE SIGNAL
  ========================================================= */

  const base = simpleSignal(tenantId, price);

  if (base.action === "WAIT") return;
  if (state.positions.scalp) return;

  /* =========================================================
  🔥 AI DECISION (THIS WAS MISSING)
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

  /* ================= FILTER BAD TRADES ================= */

  if (ai.confidence < 0.55) {
    return; // AI rejects weak trades
  }

  /* ================= TRACK DECISION ================= */

  state.executionStats.decisions++;

  state.decisions.push({
    action: base.action,
    confidence: ai.confidence,
    time: ts,
    regime: ai.regime,
  });

  if (state.decisions.length > 500) {
    state.decisions.shift();
  }

  /* =========================================================
  OPEN TRADE
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
      side: base.action,
      price,
      time: ts,
      confidence: ai.confidence,
    });

    if (global.broadcastTrade) {
      global.broadcastTrade(
        {
          side: base.action,
          price,
          time: ts,
        },
        tenantId
      );
    }
  }

  return {
    base,
    ai,
    result: res,
  };
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  processTick,
  getState,
};
