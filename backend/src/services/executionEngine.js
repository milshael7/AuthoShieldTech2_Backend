// backend/src/services/executionEngine.js
// Phase 12 — Hardened Institutional Execution Engine
// Paper + Live Unified Layer
// Safe Against Missing State Fields

const exchangeRouter = require("./exchangeRouter");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),
  baseSlippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 0.0005),
  maxSlippagePct: Number(process.env.PAPER_MAX_SLIPPAGE || 0.002),
  minOrderUsd: 50,
  maxCapitalFraction: 0.5,
  partialFillProbability: 0.35,
  minPartialFillPct: 0.4,
  simulatedLatencyMs: Number(process.env.PAPER_LATENCY_MS || 15),
  liveDryRun:
    String(process.env.LIVE_DRY_RUN || "true")
      .toLowerCase()
      .trim() !== "false",
});

/* =========================================================
   SAFE STATE INIT
========================================================= */

function ensureStateSafety(state) {
  state.costs = state.costs || { feePaid: 0 };
  state.limits = state.limits || { tradesToday: 0, lossesToday: 0 };
  state.realized = state.realized || {
    wins: 0,
    losses: 0,
    net: 0,
    grossProfit: 0,
    grossLoss: 0,
  };
  state.trades = state.trades || [];
}

/* =========================================================
   HELPERS
========================================================= */

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function simulateSlippage(price, side) {
  const slipPct = randomBetween(
    CONFIG.baseSlippagePct,
    CONFIG.maxSlippagePct
  );

  return side === "BUY"
    ? price * (1 + slipPct)
    : price * (1 - slipPct);
}

function simulatePartialFill(qty) {
  if (Math.random() > CONFIG.partialFillProbability)
    return qty;

  const fillPct = randomBetween(
    CONFIG.minPartialFillPct,
    0.95
  );

  return qty * fillPct;
}

function recalcEquity(state) {
  if (!state) return;

  if (state.position && state.lastPrice) {
    state.equity =
      state.cashBalance +
      (state.lastPrice - state.position.entry) *
        state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }

  state.peakEquity = Math.max(
    state.peakEquity || 0,
    state.equity
  );
}

function buildExecutionId() {
  return `${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/* =========================================================
   PAPER EXECUTION
========================================================= */

function executePaperOrder({
  tenantId,
  symbol,
  action,
  price,
  riskPct,
  state,
  ts = Date.now(),
}) {
  if (!state) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  ensureStateSafety(state);

  const executionId = buildExecutionId();

  /* ================= ENTRY ================= */

  if (action === "BUY" && !state.position) {
    const safeRisk = clamp(
      Number(riskPct) || 0,
      0,
      CONFIG.maxCapitalFraction
    );

    const usd = clamp(
      state.cashBalance * safeRisk,
      CONFIG.minOrderUsd,
      state.cashBalance * CONFIG.maxCapitalFraction
    );

    if (usd <= 0) return null;

    const slippedPrice = simulateSlippage(price, "BUY");

    let qty = usd / slippedPrice;
    qty = simulatePartialFill(qty);

    const notional = qty * slippedPrice;
    const fee = notional * CONFIG.feeRate;

    state.cashBalance -= notional + fee;
    state.costs.feePaid += fee;

    state.position = {
      symbol,
      entry: slippedPrice,
      qty,
      ts,
      executionId,
      riskPct: safeRisk,
      feesPaid: fee,
    };

    state.limits.tradesToday++;

    recalcEquity(state);

    return {
      result: {
        type: "ENTRY",
        symbol,
        price: slippedPrice,
        qty,
        executionId,
      },
    };
  }

  /* ================= EXIT ================= */

  if (
    (action === "SELL" || action === "CLOSE") &&
    state.position
  ) {
    const pos = state.position;

    const slippedPrice = simulateSlippage(price, "SELL");

    let qty = simulatePartialFill(pos.qty);

    const notional = qty * slippedPrice;
    const gross = (slippedPrice - pos.entry) * qty;
    const fee = notional * CONFIG.feeRate;
    const pnl = gross - fee;

    state.cashBalance += notional - fee;
    state.costs.feePaid += fee;
    state.realized.net += pnl;

    const isWin = pnl > 0;

    if (isWin) {
      state.realized.wins++;
      state.realized.grossProfit += pnl;
    } else {
      state.realized.losses++;
      state.realized.grossLoss += Math.abs(pnl);
      state.limits.lossesToday++;
    }

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      entry: pos.entry,
      exit: slippedPrice,
      qty,
      profit: pnl,
      executionId,
    });

    state.position = null;

    recalcEquity(state);

    return {
      result: {
        type: "EXIT",
        symbol,
        pnl,
        isWin,
        executionId,
      },
    };
  }

  return null;
}

/* =========================================================
   LIVE EXECUTION
========================================================= */

async function executeLiveOrder(params = {}) {
  const executionId = buildExecutionId();

  if (CONFIG.liveDryRun) {
    return {
      ok: true,
      dryRun: true,
      executionId,
    };
  }

  try {
    const routed =
      await exchangeRouter.routeLiveOrder({
        ...params,
        executionId,
      });

    return routed.ok
      ? { ok: true, executionId, result: routed.result }
      : { ok: false, executionId, error: routed.error };
  } catch (err) {
    return {
      ok: false,
      executionId,
      error: String(err?.message || err),
    };
  }
}

module.exports = {
  executePaperOrder,
  executeLiveOrder,
};
