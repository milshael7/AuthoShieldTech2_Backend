// ==========================================================
// 🔒 PROTECTED CORE FILE — DO NOT MODIFY WITHOUT AUTHORIZATION
// MODULE: ENGINE CORE (ORCHESTRATOR)
// VERSION: v1.0 (CONTROL LAYER)
//
// PURPOSE:
// - Central brain loop
// - Connects market → decision → execution → state
//
// RULES:
// 1. NO direct state mutation
// 2. NO execution logic here
// 3. ONLY orchestrates flow
// 4. Deterministic input → output
//
// ==========================================================

const { execute } = require("./executionEngine");
const { updatePrice } = require("./stateStore");

/* ================= SIMPLE DECISION ENGINE ================= */
/*
  TEMPORARY — This will later be replaced by your AI (tradeBrain)

  Right now we use simple logic so system behaves REAL:
  - If price momentum up → BUY
  - If price momentum down → SELL
*/

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

  if (mem.length > 5) {
    mem.shift();
  }

  if (mem.length < 3) {
    return { action: "WAIT" };
  }

  const last = mem[mem.length - 1];
  const prev = mem[mem.length - 2];

  if (last > prev) {
    return {
      action: "BUY",
      confidence: 0.6,
    };
  }

  if (last < prev) {
    return {
      action: "SELL",
      confidence: 0.6,
    };
  }

  return { action: "WAIT" };
}

/* ================= ENGINE TICK ================= */

function processTick({
  tenantId,
  symbol,
  price,
  ts = Date.now(),
}) {
  if (!tenantId || !symbol || !price) return null;

  // 1. Update price in state
  updatePrice(tenantId, symbol, price);

  // 2. Get decision (TEMP logic)
  const decision = simpleDecision(tenantId, price);

  // 3. Execute decision
  const result = execute({
    tenantId,
    action: decision.action,
    symbol,
    price,
    qty: 0.01, // fixed size for now
    stopLoss:
      decision.action === "BUY"
        ? price * 0.995
        : decision.action === "SELL"
        ? price * 1.005
        : null,
    takeProfit:
      decision.action === "BUY"
        ? price * 1.005
        : decision.action === "SELL"
        ? price * 0.995
        : null,
    ts,
  });

  return {
    decision,
    result,
  };
}

/* ================= EXPORT ================= */

module.exports = {
  processTick,
};
