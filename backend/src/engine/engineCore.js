// ==========================================================
// ENGINE CORE v3.0 (AI DRIVEN EXECUTION LOOP)
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
      lastPrice: null,
    });
  }

  return ENGINE_STATE.get(key);
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
AI DECISION FILTER
========================================================= */

function interpretDecision(ai) {
  const confidence = ai.confidence || 0;
  const edge = ai.edge || 0;

  if (confidence < 0.55) return "WAIT";

  if (edge > 0.001) return "BUY";
  if (edge < -0.001) return "SELL";

  return "WAIT";
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

  const lastPrice = state.lastPrice || price;
  state.lastPrice = price;

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

  /* ================= AI DECISION ================= */

  const ai = aiBrain.decide({
    tenantId,
    symbol,
    last: lastPrice,
    paper: {
      volatility: Math.abs(price - lastPrice) / Math.max(lastPrice, 1),
      equity: 10000,
      peakEquity: 10000,
    },
    baseConfidence: 0.5,
    baseEdge: (price - lastPrice) / Math.max(lastPrice, 1),
    pattern: "auto",
    setup: "scalp",
  });

  const action = interpretDecision(ai);

  if (action === "WAIT") return;

  if (state.positions.scalp) return; // no stacking

  /* ================= OPEN ================= */

  const stopLoss =
    action === "BUY"
      ? price * 0.995
      : price * 1.005;

  const takeProfit =
    action === "BUY"
      ? price * 1.006
      : price * 0.994;

  const res = executePaperOrder({
    tenantId,
    symbol,
    action,
    price,
    qty: 0.01,
    stopLoss,
    takeProfit,
    state,
    ts,
    decisionMeta: {
      confidence: ai.confidence,
      pattern: "auto",
      setup: "scalp",
    },
  });

  if (res?.result) {
    const trade = {
      side: action,
      price,
      time: ts,
    };

    state.trades.push(trade);

    if (global.broadcastTrade) {
      global.broadcastTrade(trade, tenantId);
    }
  }

  return {
    decision: ai,
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
