// backend/src/services/riskManager.js
// Phase 6 — Global Risk Control System
// Institutional-Grade Risk Layer
// Multi-Tenant Safe • Portfolio Aware • Volatility Aware • Self-Throttling

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   BASE CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxDailyLossPct: Number(process.env.RISK_MAX_DAILY_LOSS_PCT || 0.04),   // 4%
  maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT || 0.25),     // 25%
  lossClusterSize: Number(process.env.RISK_LOSS_CLUSTER_SIZE || 3),
  cooldownMs: Number(process.env.RISK_COOLDOWN_MS || 60_000),            // 1 min
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
      lossClusterCount: 0,

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
  realizedNet,
  volatility,
  trades = [],
  limits = {},
  ts = Date.now(),
}) {
  const state = getState(tenantId);
  const dk = dayKey(ts);

  /* ---------------- Daily Reset ---------------- */

  if (state.lastDayKey !== dk) {
    state.lastDayKey = dk;
    state.dailyStartEquity = equity;
    state.lossClusterCount = 0;
  }

  if (state.peakEquity == null) {
    state.peakEquity = equity;
  }

  state.peakEquity = Math.max(state.peakEquity, equity);

  /* ---------------- Drawdown Protection ---------------- */

  const drawdown =
    state.peakEquity > 0
      ? (state.peakEquity - equity) / state.peakEquity
      : 0;

  if (drawdown >= CONFIG.maxDrawdownPct) {
    state.halted = true;
    state.haltReason = "max_drawdown";
  }

  /* ---------------- Daily Loss Limit ---------------- */

  if (state.dailyStartEquity) {
    const dailyLoss =
      (state.dailyStartEquity - equity) /
      state.dailyStartEquity;

    if (dailyLoss >= CONFIG.maxDailyLossPct) {
      state.halted = true;
      state.haltReason = "daily_loss_limit";
    }
  }

  /* ---------------- Loss Cluster Detection ---------------- */

  if (trades.length >= CONFIG.lossClusterSize) {
    const recent = trades.slice(-CONFIG.lossClusterSize);
    const allLoss = recent.every(t => t.profit <= 0);

    if (allLoss) {
      state.lossClusterCount++;
      state.cooldownUntil = Date.now() + CONFIG.cooldownMs;
    }
  }

  /* ---------------- Cooldown Enforcement ---------------- */

  const cooling = Date.now() < state.cooldownUntil;

  /* ---------------- Volatility Regime Detection ---------------- */

  if (volatility >= CONFIG.highVolatilityCutoff) {
    state.riskMultiplier = 0.6; // reduce risk in chaos
  } else if (volatility <= CONFIG.lowVolatilityCutoff) {
    state.riskMultiplier = 1.2; // allow slightly more in calm markets
  } else {
    state.riskMultiplier = 1;
  }

  /* ---------------- Final Risk Status ---------------- */

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

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  evaluate,
  resetTenant,
};
