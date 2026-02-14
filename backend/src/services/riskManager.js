// backend/src/services/riskManager.js
// Phase 22 — Institutional Adaptive Risk Engine
// Cross-Margin Aware • Drawdown Reactive • Volatility Regime Memory
// Margin Pressure Control • Liquidation Buffering
// Tenant Safe • Paper + Live Compatible • Production Hardened

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxDailyLossPct: Number(process.env.RISK_MAX_DAILY_LOSS_PCT || 0.04),
  maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT || 0.25),

  equityFloorPct: Number(process.env.RISK_EQUITY_FLOOR_PCT || 0.35),

  lossClusterSize: Number(process.env.RISK_LOSS_CLUSTER_SIZE || 3),
  baseCooldownMs: Number(process.env.RISK_COOLDOWN_MS || 60_000),

  highVolatilityCutoff: Number(process.env.RISK_VOL_HIGH || 0.015),
  lowVolatilityCutoff: Number(process.env.RISK_VOL_LOW || 0.002),

  maxMarginUtilization: Number(process.env.RISK_MAX_MARGIN_UTIL || 0.65),
  liquidationBufferPct: Number(process.env.RISK_LIQ_BUFFER || 0.15),
});

/* =========================================================
   TENANT STATE
========================================================= */

const RISK_STATE = new Map();

function getState(tenantId) {
  const key = tenantId || "__default__";

  if (!RISK_STATE.has(key)) {
    RISK_STATE.set(key, {
      version: 22,

      halted: false,
      haltReason: null,

      cooldownUntil: 0,
      cooldownLevel: 0,
      lastClusterTradeCount: 0,

      peakEquity: null,
      rollingPeak: null,
      dailyStartEquity: null,
      firstEquitySeen: null,
      lastDayKey: null,

      riskMultiplier: 1,
      volatilityRegime: "normal",

      lastMarginPressure: 0,
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
  volatility = 0,
  trades = [],
  marginUsed = 0,
  maintenanceRequired = 0,
  ts = Date.now(),
}) {
  const state = getState(tenantId);
  const dk = dayKey(ts);

  if (!Number.isFinite(equity) || equity <= 0) {
    return {
      halted: true,
      haltReason: "invalid_equity",
      cooling: false,
      riskMultiplier: 0,
      drawdown: 1,
    };
  }

  /* ================= DAILY RESET ================= */

  if (state.lastDayKey !== dk) {
    state.lastDayKey = dk;
    state.dailyStartEquity = equity;
    state.cooldownLevel = 0;
    state.cooldownUntil = 0;
    state.halted = false;
    state.haltReason = null;
  }

  /* ================= INITIAL EQUITY ================= */

  if (state.firstEquitySeen == null) {
    state.firstEquitySeen = equity;
  }

  /* ================= PEAK TRACKING ================= */

  if (state.peakEquity == null) {
    state.peakEquity = equity;
  }

  state.peakEquity = Math.max(state.peakEquity, equity);

  if (state.rollingPeak == null) {
    state.rollingPeak = equity;
  }

  state.rollingPeak =
    state.rollingPeak * 0.995 + equity * 0.005;

  const drawdown =
    state.peakEquity > 0
      ? (state.peakEquity - equity) / state.peakEquity
      : 0;

  const rollingDrawdown =
    state.rollingPeak > 0
      ? (state.rollingPeak - equity) / state.rollingPeak
      : 0;

  /* ================= HARD DRAWDOWN ================= */

  if (drawdown >= CONFIG.maxDrawdownPct) {
    state.halted = true;
    state.haltReason = "max_drawdown";
  }

  /* ================= EQUITY FLOOR ================= */

  const floor =
    state.firstEquitySeen *
    CONFIG.equityFloorPct;

  if (equity <= floor) {
    state.halted = true;
    state.haltReason = "equity_floor_breach";
  }

  /* ================= DAILY LOSS ================= */

  if (state.dailyStartEquity > 0) {
    const dailyLoss =
      (state.dailyStartEquity - equity) /
      state.dailyStartEquity;

    if (dailyLoss >= CONFIG.maxDailyLossPct) {
      state.halted = true;
      state.haltReason = "daily_loss_limit";
    }
  }

  /* ================= LOSS CLUSTER ================= */

  if (
    trades.length >= CONFIG.lossClusterSize &&
    trades.length !== state.lastClusterTradeCount
  ) {
    const recent = trades.slice(-CONFIG.lossClusterSize);
    const allLoss = recent.every(t => t.profit <= 0);

    if (allLoss) {
      state.cooldownLevel++;
      const cooldown =
        CONFIG.baseCooldownMs *
        Math.pow(1.8, state.cooldownLevel - 1);

      state.cooldownUntil = ts + cooldown;
    }

    state.lastClusterTradeCount = trades.length;
  }

  const cooling = ts < state.cooldownUntil;

  /* ================= VOLATILITY REGIME ================= */

  if (volatility >= CONFIG.highVolatilityCutoff) {
    state.volatilityRegime = "high";
  } else if (volatility <= CONFIG.lowVolatilityCutoff) {
    state.volatilityRegime = "low";
  } else {
    state.volatilityRegime = "normal";
  }

  if (state.volatilityRegime === "high") {
    state.riskMultiplier = 0.6;
  } else if (state.volatilityRegime === "low") {
    state.riskMultiplier = 1.2;
  } else {
    state.riskMultiplier = 1;
  }

  /* ================= MARGIN PRESSURE ================= */

  let marginPressure = 0;

  if (marginUsed > 0 && equity > 0) {
    marginPressure = marginUsed / equity;
  }

  state.lastMarginPressure = marginPressure;

  if (marginPressure >= CONFIG.maxMarginUtilization) {
    state.halted = true;
    state.haltReason = "margin_utilization_limit";
  }

  /* ================= LIQUIDATION BUFFER ================= */

  if (
    maintenanceRequired > 0 &&
    equity <= maintenanceRequired * (1 + CONFIG.liquidationBufferPct)
  ) {
    state.riskMultiplier *= 0.25;
  }

  /* ================= SOFT DRAWDOWN THROTTLE ================= */

  if (!state.halted && rollingDrawdown > 0.12) {
    state.riskMultiplier *= 0.75;
  }

  /* ================= FINAL RETURN ================= */

  return {
    halted: state.halted,
    haltReason: state.haltReason,
    cooling,
    riskMultiplier: clamp(state.riskMultiplier, 0.2, 1.5),
    drawdown,
    rollingDrawdown,
    volatilityRegime: state.volatilityRegime,
    cooldownLevel: state.cooldownLevel,
    marginPressure,
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
