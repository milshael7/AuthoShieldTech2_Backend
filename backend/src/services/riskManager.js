// backend/src/services/riskManager.js
// Phase 7 — Institutional Global Risk Layer
// Stable • Recoverable • Tenant Safe • Self-Throttling

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   BASE CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxDailyLossPct: Number(process.env.RISK_MAX_DAILY_LOSS_PCT || 0.04),
  maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT || 0.25),

  lossClusterSize: Number(process.env.RISK_LOSS_CLUSTER_SIZE || 3),
  cooldownMs: Number(process.env.RISK_COOLDOWN_MS || 60_000),

  highVolatilityCutoff: Number(process.env.RISK_VOL_HIGH || 0.015),
  lowVolatilityCutoff: Number(process.env.RISK_VOL_LOW || 0.002),
});

/* =========================================================
   TENANT RISK STATE
========================================================= */

const RISK_STATE = new Map();

function getState(tenantId) {
  const key = tenantId || "__default__";

  if (!RISK_STATE.has(key)) {
    RISK_STATE.set(key, {
      halted: false,
      haltReason: null,

      cooldownUntil: 0,
      lastClusterTradeCount: 0,

      peakEquity: null,
      dailyStartEquity: null,
      lastDayKey: null,

      riskMultiplier: 1,
    });
  }

  return RISK_STATE.get(key);
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/* =========================================================
   CORE EVALUATION
========================================================= */

function evaluate({
  tenantId,
  equity,
  volatility,
  trades = [],
  ts = Date.now(),
}) {
  const state = getState(tenantId);
  const dk = dayKey(ts);

  /* ---------------- DAILY RESET ---------------- */

  if (state.lastDayKey !== dk) {
    state.lastDayKey = dk;
    state.dailyStartEquity = equity;
    state.cooldownUntil = 0;
    state.halted = false;
    state.haltReason = null;
  }

  /* ---------------- PEAK TRACKING ---------------- */

  if (state.peakEquity == null) {
    state.peakEquity = equity;
  }

  state.peakEquity = Math.max(state.peakEquity, equity);

  /* ---------------- DRAWDOWN PROTECTION ---------------- */

  const drawdown =
    state.peakEquity > 0
      ? (state.peakEquity - equity) / state.peakEquity
      : 0;

  if (drawdown >= CONFIG.maxDrawdownPct) {
    state.halted = true;
    state.haltReason = "max_drawdown";
  }

  /* ---------------- DAILY LOSS LIMIT ---------------- */

  if (state.dailyStartEquity > 0) {
    const dailyLoss =
      (state.dailyStartEquity - equity) /
      state.dailyStartEquity;

    if (dailyLoss >= CONFIG.maxDailyLossPct) {
      state.halted = true;
      state.haltReason = "daily_loss_limit";
    }
  }

  /* ---------------- LOSS CLUSTER DETECTION ---------------- */

  if (
    trades.length >= CONFIG.lossClusterSize &&
    trades.length !== state.lastClusterTradeCount
  ) {
    const recent = trades.slice(-CONFIG.lossClusterSize);
    const allLoss = recent.every(t => t.profit <= 0);

    if (allLoss) {
      state.cooldownUntil = ts + CONFIG.cooldownMs;
    }

    state.lastClusterTradeCount = trades.length;
  }

  const cooling = ts < state.cooldownUntil;

  /* ---------------- VOLATILITY REGIME ---------------- */

  if (volatility >= CONFIG.highVolatilityCutoff) {
    state.riskMultiplier = 0.6;
  } else if (volatility <= CONFIG.lowVolatilityCutoff) {
    state.riskMultiplier = 1.15;
  } else {
    state.riskMultiplier = 1;
  }

  /* ---------------- FINAL STATUS ---------------- */

  return {
    halted: state.halted,
    haltReason: state.haltReason,
    cooling,
    riskMultiplier: clamp(state.riskMultiplier, 0.5, 1.5),
    drawdown,
  };
}

/* =========================================================
   RESET
========================================================= */

function resetTenant(tenantId) {
  RISK_STATE.delete(tenantId);
}

module.exports = {
  evaluate,
  resetTenant,
};
