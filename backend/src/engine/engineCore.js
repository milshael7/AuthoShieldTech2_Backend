// ==========================================================
// ENGINE CORE v2.0 (FULL EXECUTION LOOP)
// ==========================================================

const { executePaperOrder } = require("../services/executionEngine");
const { updatePrice } = require("./stateStore");

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
    });
  }

  return ENGINE_STATE.get(key);
}

/* =========================================================
SIMPLE DECISION (TEMP)
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

  if (mem.length < 3) return { action: "WAIT" };

  const last = mem[mem.length - 1];
  const prev = mem[mem.length - 2];

  if (last > prev) return { action: "BUY", confidence: 0.6 };
  if (last < prev) return { action: "SELL", confidence: 0.6 };

  return { action: "WAIT" };
}

/* =========================================================
POSITION MANAGEMENT
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

function processTick({
  tenantId,
  symbol,
  price,
  ts = Date.now(),
}) {
  if (!tenantId || !symbol || !price) return null;

  const state = getState(tenantId);

  // 1. Update price
  updatePrice(tenantId, symbol, price);

  const currentPos = state.positions.scalp;

  /* ================= CLOSE LOGIC ================= */

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
      });

      if (res?.result) {
        const trade = {
          side: closeReason,
          price,
          time: ts,
        };

        state.trades.push(trade);

        if (global.broadcastTrade) {
          global.broadcastTrade(trade, tenantId);
        }
      }

      return;
    }
  }

  /* ================= DECISION ================= */

  const decision = simpleDecision(tenantId, price);

  if (decision.action === "WAIT") return;

  if (state.positions.scalp) return; // no stacking

  /* ================= OPEN ================= */

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
  });

  if (res?.result) {
    const trade = {
      side: decision.action,
      price,
      time: ts,
    };

    state.trades.push(trade);

    if (global.broadcastTrade) {
      global.broadcastTrade(trade, tenantId);
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
