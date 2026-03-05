// backend/src/services/executionEngine.js
// ==========================================================
// Institutional Execution Engine — STABLE & DETERMINISTIC
// Paper Trading + Live Trading Auto Router
// Capital Guard Safe • Accounting Correct
// ==========================================================

const exchangeRouter = require("./exchangeRouter");
const krakenConnector = require("./krakenConnector");
const liveTradingGuard = require("./liveTradingGuard");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({
  feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),

  baseSlippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 0.0004),
  maxSlippagePct: Number(process.env.PAPER_MAX_SLIPPAGE || 0.0015),

  minOrderUsd: Number(process.env.PAPER_MIN_ORDER_USD || 50),
  maxCapitalFraction:
    Number(process.env.PAPER_MAX_CAPITAL_FRACTION || 0.5),

  maxDailyTrades:
    Number(process.env.LIVE_MAX_TRADES_PER_DAY || 12),

  maxNotionalUsd:
    Number(process.env.LIVE_MAX_NOTIONAL_USD || 25000),

  minAccountBalance:
    Number(process.env.LIVE_MIN_ACCOUNT_BALANCE || 50),
});

/* =========================================================
SAFE STATE
========================================================= */

function ensureStateSafety(state) {
  state.cashBalance ??= 0;
  state.equity ??= state.cashBalance;
  state.peakEquity ??= state.cashBalance;

  state.lastPrice ??= null;

  state.costs ??= { feePaid: 0 };

  state.realized ??= {
    wins: 0,
    losses: 0,
    net: 0,
    grossProfit: 0,
    grossLoss: 0,
  };

  state.limits ??= {
    tradesToday: 0,
    lossesToday: 0,
    lastResetDay: new Date().toISOString().slice(0, 10),
  };

  state.trades ??= [];
}

/* =========================================================
HELPERS
========================================================= */

function resetDailyLimitsIfNeeded(state, ts) {
  const day = new Date(ts).toISOString().slice(0, 10);
  if (state.limits.lastResetDay !== day) {
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
    state.limits.lastResetDay = day;
  }
}

function deterministicSlippage(price, side) {
  // midpoint slippage → deterministic
  const slipPct =
    (CONFIG.baseSlippagePct + CONFIG.maxSlippagePct) / 2;

  return side === "BUY"
    ? price * (1 + slipPct)
    : price * (1 - slipPct);
}

function recalcEquity(state) {
  if (state.position && state.lastPrice) {
    state.equity =
      state.cashBalance +
      (state.lastPrice - state.position.entry) *
        state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }

  state.peakEquity =
    Math.max(state.peakEquity || 0, state.equity);
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
  resetDailyLimitsIfNeeded(state, ts);

  state.lastPrice = price;

  const executionId = buildExecutionId();

  /* ================= ENTRY ================= */

  if (action === "BUY" && !state.position) {
    if (state.limits.tradesToday >= CONFIG.maxDailyTrades)
      return null;

    const safeRisk =
      clamp(Number(riskPct) || 0, 0, CONFIG.maxCapitalFraction);

    const maxUsd =
      state.cashBalance * CONFIG.maxCapitalFraction;

    const usd = clamp(
      state.cashBalance * safeRisk,
      CONFIG.minOrderUsd,
      maxUsd
    );

    if (usd <= 0 || usd > state.cashBalance) return null;

    const fillPrice =
      deterministicSlippage(price, "BUY");

    const qty = usd / fillPrice;
    const notional = qty * fillPrice;
    const fee = notional * CONFIG.feeRate;

    if (state.cashBalance - notional - fee < 0) return null;

    state.cashBalance -= notional + fee;
    state.costs.feePaid += fee;

    state.position = {
      symbol,
      entry: fillPrice,
      qty,
      ts,
      executionId,
      riskPct: safeRisk,
    };

    state.limits.tradesToday++;

    recalcEquity(state);

    return {
      result: {
        type: "ENTRY",
        side: "BUY",
        symbol,
        price: fillPrice,
        qty,
        executionId,
      },
    };
  }

  /* ================= EXIT ================= */

  if ((action === "SELL" || action === "CLOSE") && state.position) {
    const pos = state.position;

    const fillPrice =
      deterministicSlippage(price, "SELL");

    const qty = pos.qty;
    const notional = qty * fillPrice;

    const gross = (fillPrice - pos.entry) * qty;
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
      state.limits.lossesToday++;
    }

    state.trades.push({
      time: ts,
      side: "SELL",
      symbol: pos.symbol,
      qty,
      price: fillPrice,
      entry: pos.entry,
      profit: pnl,
      executionId,
    });

    state.position = null;

    recalcEquity(state);

    return {
      result: {
        type: "EXIT",
        side: "SELL",
        symbol,
        pnl,
        isWin: pnl > 0,
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

/* =========================================================
CAPITAL GUARD
========================================================= */

async function capitalGuard(params = {}) {
  if (process.env.EXECUTION_KILL_SWITCH === "true") {
    return { ok: false, reason: "Kill switch active" };
  }

  const balance =
    await krakenConnector.getBalance();

  const usd =
    Number(balance?.USD || balance?.ZUSD || 0);

  if (usd < CONFIG.minAccountBalance) {
    return { ok: false, reason: "Low balance" };
  }

  if (params?.notionalUsd > CONFIG.maxNotionalUsd) {
    return { ok: false, reason: "Max notional exceeded" };
  }

  return { ok: true };
}

/* =========================================================
AUTO ROUTER
========================================================= */

async function executeOrder(params) {
  const tradingEnabled =
    await liveTradingGuard.isTradingEnabled();

  if (!tradingEnabled) {
    return executePaperOrder(params);
  }

  const guard = await capitalGuard(params);
  if (!guard.ok) {
    return executePaperOrder(params);
  }

  return executeLiveOrder(params);
}

module.exports = {
  executePaperOrder,
  executeLiveOrder,
  executeOrder,
};
