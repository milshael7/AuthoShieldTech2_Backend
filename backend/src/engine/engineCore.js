// ==========================================================
// ENGINE CORE v5.0 (SINGLE BRAIN — MEMORY CONNECTED)
// MAINTENANCE SAFE — DO NOT ADD SECOND BRAIN
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
const { updatePrice } = require("./stateStore");

// 🔥 ONLY BRAIN (SOURCE OF TRUTH)
const memoryBrain = require("../../brainMemory/memoryBrain");

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
SIMPLE DECISION (TEMP — UNTIL ADVANCED AI LAYER)
========================================================= */

const PRICE_MEMORY = new Map();

function getMemory(tenantId) {
  const key = String(tenantId || "__default__");

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  return PRICE_MEMORY.get(key);
}

function simpleDecision(tenantId, price) {
  const mem = getMemory(tenantId);

  mem.push(price);
  if (mem.length > 5) mem.shift();

  if (mem.length < 3) {
    return { action: "WAIT", confidence: 0 };
  }

  const last = mem[mem.length - 1];
  const prev = mem[mem.length - 2];

  if (last > prev) {
    return {
      action: "BUY",
      confidence: 0.6,
      edge: 0.001,
    };
  }

  if (last < prev) {
    return {
      action: "SELL",
      confidence: 0.6,
      edge: -0.001,
    };
  }

  return { action: "WAIT", confidence: 0, edge: 0 };
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

        // 🔥 RECORD TRADE TO REAL BRAIN
        memoryBrain.recordTrade({
          tenantId,
          symbol: currentPos.symbol,
          entry: currentPos.entry,
          exit: price,
          qty: currentPos.qty,
          pnl: res.result.pnl,
          confidence: currentPos.confidence || 0,
          edge: 0,
          volatility: 0,
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
  DECISION
  ========================================================= */

  const decision = simpleDecision(tenantId, price);

  if (decision.action !== "WAIT") {
    state.executionStats.decisions++;

    state.decisions.push({
      ...decision,
      time: ts,
    });

    if (state.decisions.length > 500) {
      state.decisions.shift();
    }

    // 🔥 RECORD SIGNAL TO REAL BRAIN
    memoryBrain.recordSignal({
      tenantId,
      symbol,
      action: decision.action,
      confidence: decision.confidence,
      edge: decision.edge,
      price,
      volatility: 0,
    });
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
