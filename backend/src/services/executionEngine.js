// backend/src/services/executionEngine.js
// Phase 9 — Institutional Execution Engine
// Handles paper execution logic
// Unified execution layer for Paper + Future Live Adapter

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),
  slippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 0.0005), // 0.05%
});

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

  /* ================= ENTRY ================= */

  if (action === "BUY" && !state.position) {
    const usd = clamp(
      state.cashBalance * riskPct,
      50,
      state.cashBalance * 0.5
    );

    if (usd <= 0) return null;

    // apply slippage against trader
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

    state.limits.tradesToday++;

    return {
      narration: {
        text: `Entered ${symbol} at ${slippedPrice.toFixed(
          2
        )}`,
        meta: {
          action: "BUY",
          usd,
          slippedPrice,
        },
      },
    };
  }

  /* ================= EXIT ================= */

  if (
    (action === "SELL" || action === "CLOSE") &&
    state.position
  ) {
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
      state.limits.lossesToday++;
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

    return {
      narration: {
        text: `Closed ${symbol}. ${
          pnl >= 0 ? "Profit" : "Loss"
        } ${pnl.toFixed(2)}`,
        meta: {
          action: "CLOSE",
          pnl,
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
