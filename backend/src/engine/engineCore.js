// ==========================================================
// ENGINE CORE v3.1 (STABLE + AI TRACKING FIXED)
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
DECISION MEMORY
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

  if (mem.length < 3) return { action: "WAIT", confidence: 0 };

  const last = mem[mem.length - 1];
  const prev = mem[mem.length - 2];

  if (last > prev) {
    return {
      action: "BUY",
      confidence: 0.6 + Math.random() * 0.2, // slight realism
    };
  }

  if (last < prev) {
    return {
      action: "SELL",
      confidence: 0.6 + Math.random() * 0.2,
    };
  }

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

  /* ================= TICK ================= */
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

  // 🔥 ONLY TRACK REAL DECISIONS
  if (decision.action !== "WAIT") {
    state.executionStats.decisions++;

    state.decisions.push({
      ...decision,
      time: ts,
    });

    // cap memory
    if (state.decisions.length > 500) {
      state.decisions.shift();
    }
  }

  if (decision.action === "WAIT") return;
  if (state.positions.scalp) return;

  /* =========================================================
  OPEN
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

    // 🔥 PUSH OPEN TRADE INTO STATE
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
