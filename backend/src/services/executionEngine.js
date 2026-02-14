// backend/src/services/executionEngine.js
// Phase 9.1 — Institutional Execution Engine (Hardened)
// Handles paper execution logic
// Unified execution layer for Paper + Future Live Adapter

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),
  slippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 0.0005),
  minOrderUsd: 50,
  maxCapitalFraction: 0.5,
});

/* =========================================================
   INTERNAL HELPERS
========================================================= */

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

function validAction(a) {
  return a === "BUY" || a === "SELL" || a === "CLOSE";
}

/* =========================================================
   CORE PAPER EXECUTION
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
  if (!validAction(action)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  /* ================= ENTRY ================= */

  if (action === "BUY") {
    if (state.position) return null;

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

    if (!Number.isFinite(usd) || usd <= 0) return null;

    const slippedPrice =
      price * (1 + CONFIG.slippagePct);

    const qty = usd / slippedPrice;
    const fee = usd * CONFIG.feeRate;

    state.cashBalance -= usd + fee;
    state.costs.feePaid += fee;

    state.position = {
      symbol,
      entry: slippedPrice,
      qty,
      ts,
    };

    state.limits.tradesToday =
      (state.limits.tradesToday || 0) + 1;

    recalcEquity(state);

    return {
      narration: {
        text: `Entered ${symbol} at ${slippedPrice.toFixed(
          2
        )}`,
        meta: {
          action: "BUY",
          usd,
          slippedPrice,
          qty,
        },
      },
    };
  }

  /* ================= EXIT ================= */

  if (action === "SELL" || action === "CLOSE") {
    if (!state.position) return null;

    const pos = state.position;

    const slippedPrice =
      price * (1 - CONFIG.slippagePct);

    const gross =
      (slippedPrice - pos.entry) * pos.qty;

    const fee =
      Math.abs(slippedPrice * pos.qty) *
      CONFIG.feeRate;

    const pnl = gross - fee;

    state.cashBalance +=
      pos.qty * slippedPrice - fee;

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
      type: "CLOSE",
      entry: pos.entry,
      exit: slippedPrice,
      qty: pos.qty,
      profit: pnl,
    });

    state.position = null;

    recalcEquity(state);

    return {
      narration: {
        text: `Closed ${symbol}. ${
          pnl >= 0 ? "Profit" : "Loss"
        } ${pnl.toFixed(2)}`,
        meta: {
          action: "CLOSE",
          pnl,
          slippedPrice,
        },
      },
    };
  }

  return null;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  executePaperOrder,
};
