// backend/src/services/executionEngine.js
// Phase 10 — Institutional Execution Engine
// Paper + Live Unified Layer
// Partial Fills • Slippage • Routing • Audit Trail • Adapter Safe

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

  liveDryRun: String(process.env.LIVE_DRY_RUN || "true")
    .toLowerCase()
    .trim() !== "false",
});

/* =========================================================
   INTERNAL HELPERS
========================================================= */

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function simulateSlippage(price, side) {
  const slipPct = randomBetween(
    CONFIG.baseSlippagePct,
    CONFIG.maxSlippagePct
  );

  if (side === "BUY") return price * (1 + slipPct);
  return price * (1 - slipPct);
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

function pushAudit(state, record) {
  state.executionAudit = state.executionAudit || [];
  state.executionAudit.push({
    ts: Date.now(),
    ...record,
  });

  state.executionAudit =
    state.executionAudit.slice(-500);
}

function narration(text, meta) {
  return {
    narration: {
      text,
      meta,
    },
  };
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

    state.limits.tradesToday =
      (state.limits.tradesToday || 0) + 1;

    recalcEquity(state);

    pushAudit(state, {
      type: "PAPER_ENTRY",
      symbol,
      qty,
      price: slippedPrice,
      fee,
      executionId,
    });

    return narration(
      `Entered ${symbol} at ${slippedPrice.toFixed(2)}`,
      { action: "BUY", qty, executionId }
    );
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

    if (pnl > 0) {
      state.realized.wins++;
      state.realized.grossProfit += pnl;
    } else {
      state.realized.losses++;
      state.realized.grossLoss += Math.abs(pnl);
      state.limits.lossesToday =
        (state.limits.lossesToday || 0) + 1;
    }

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      entry: pos.entry,
      exit: slippedPrice,
      qty,
      profit: pnl,
      executionId,
      latencyMs: CONFIG.simulatedLatencyMs,
    });

    state.position = null;

    recalcEquity(state);

    pushAudit(state, {
      type: "PAPER_EXIT",
      symbol,
      qty,
      price: slippedPrice,
      pnl,
      executionId,
    });

    return narration(
      `Closed ${symbol}. ${
        pnl >= 0 ? "Profit" : "Loss"
      } ${pnl.toFixed(2)}`,
      { action: "CLOSE", pnl, executionId }
    );
  }

  return null;
}

/* =========================================================
   LIVE EXECUTION (ROUTED)
========================================================= */

async function executeLiveOrder(params = {}) {
  const executionId = buildExecutionId();

  if (CONFIG.liveDryRun) {
    return {
      ok: true,
      dryRun: true,
      executionId,
      note: "LIVE_DRY_RUN enabled — no exchange call made.",
    };
  }

  try {
    const routed = await exchangeRouter.routeLiveOrder({
      ...params,
      executionId,
    });

    if (!routed.ok) {
      return {
        ok: false,
        executionId,
        error: routed.error,
      };
    }

    return {
      ok: true,
      executionId,
      exchange: routed.exchange,
      result: routed.result,
    };
  } catch (err) {
    return {
      ok: false,
      executionId,
      error: String(err?.message || err),
    };
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  executePaperOrder,
  executeLiveOrder,
};
