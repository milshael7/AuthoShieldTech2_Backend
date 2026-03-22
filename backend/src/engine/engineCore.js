// ==========================================================
// ENGINE CORE v4.0 (CONNECTED TO OUTSIDE BRAIN)
// MAINTENANCE SAFE — DO NOT SPLIT BRAIN SYSTEM
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
const { updatePrice } = require("./stateStore");

// 🔥 CONNECT REAL PERSISTENT BRAIN
const aiBrain = require("../../brain/aiBrain");

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

        // 🔥 FEED LEARNING INTO REAL BRAIN
        aiBrain.recordTradeOutcome({
          tenantId,
          pnl: res.result.pnl || 0,
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
  🧠 REAL AI DECISION
  ========================================================= */

  const decision = aiBrain.decide({
    tenantId,
    last: price,
    paper: {}, // can extend later
  });

  state.executionStats.decisions++;

  state.decisions.push({
    ...decision,
    time: ts,
  });

  if (state.decisions.length > 500) {
    state.decisions.shift();
  }

  if (decision.action === "WAIT") return;
  if (state.positions.scalp) return;

  /* =========================================================
  OPEN TRADE
  ========================================================= */

  const res = executePaperOrder({
    tenantId,
    symbol,
    action: decision.action,
    price,
    qty: 0.01,
    stopLoss:
      decision.action === "BUY"
        ? price * 0.995
        : price * 1.005,
    takeProfit:
      decision.action === "BUY"
        ? price * 1.005
        : price * 0.995,
    state,
    ts,
    decisionMeta: decision,
  });

  if (res?.result) {
    state.executionStats.trades++;

    state.trades.push({
      side: decision.action,
      price,
      time: ts,
      confidence: decision.confidence,
    });

    // 🔥 LOG SIGNAL TO BRAIN
    aiBrain.recordSignal({
      tenantId,
      action: decision.action,
      confidence: decision.confidence,
      edge: decision.edge,
    });

    if (global.broadcastTrade) {
      global.broadcastTrade(
        {
          side: decision.action,
          price,
          time: ts,
        },
        tenantId
      );
    }
  }

  return {
    decision,
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
