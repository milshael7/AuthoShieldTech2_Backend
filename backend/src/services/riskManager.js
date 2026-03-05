// backend/src/services/riskManager.js
// ==========================================================
// Institutional Dual-Mode Risk Engine
// Live = Capital Protection
// Paper = Learning Protection
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxDailyLossPct: Number(process.env.RISK_MAX_DAILY_LOSS_PCT || 0.04),
  maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT || 0.25),
  equityFloorPct: Number(process.env.RISK_EQUITY_FLOOR_PCT || 0.35),

  lossClusterSize: Number(process.env.RISK_LOSS_CLUSTER_SIZE || 3),
  baseCooldownMs: Number(process.env.RISK_COOLDOWN_MS || 60000),

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

    RISK_STATE.set(key,{
      halted:false,
      haltReason:null,

      cooldownUntil:0,
      cooldownLevel:0,
      lastClusterTradeCount:0,

      peakEquity:null,
      rollingPeak:null,
      dailyStartEquity:null,
      firstEquitySeen:null,
      lastDayKey:null,

      volatilityRegime:"normal",
      lastMarginPressure:0
    });

  }

  return RISK_STATE.get(key);
}

function dayKey(ts){
  return new Date(ts).toISOString().slice(0,10);
}

/* =========================================================
EVALUATION
========================================================= */

function evaluate({
  tenantId,
  equity,
  volatility=0,
  trades=[],
  marginUsed=0,
  maintenanceRequired=0,
  ts=Date.now(),
  mode="live"
}){

  const state = getState(tenantId);
  const dk = dayKey(ts);

  const isPaper = mode === "paper";

  if(!Number.isFinite(equity) || equity <= 0){

    return{
      halted:true,
      haltReason:"invalid_equity",
      cooling:false,
      riskMultiplier:0,
      drawdown:1
    };

  }

  /* ================= DAILY RESET ================= */

  if(state.lastDayKey !== dk){

    state.lastDayKey = dk;
    state.dailyStartEquity = equity;
    state.cooldownLevel = 0;
    state.cooldownUntil = 0;
    state.halted = false;
    state.haltReason = null;

  }

  /* ================= EQUITY TRACKING ================= */

  if(state.firstEquitySeen == null)
    state.firstEquitySeen = equity;

  if(state.peakEquity == null)
    state.peakEquity = equity;

  state.peakEquity = Math.max(state.peakEquity,equity);

  if(state.rollingPeak == null)
    state.rollingPeak = equity;

  state.rollingPeak =
    state.rollingPeak * 0.995 +
    equity * 0.005;

  const safePeak = state.peakEquity || 1;
  const safeRolling = state.rollingPeak || 1;

  const drawdown =
    (safePeak - equity) / safePeak;

  const rollingDrawdown =
    (safeRolling - equity) / safeRolling;

  /* =====================================================
  HARD CAPITAL STOPS (LIVE ONLY)
  ===================================================== */

  if(!isPaper){

    if(drawdown >= CONFIG.maxDrawdownPct){
      state.halted = true;
      state.haltReason = "max_drawdown";
    }

    const floor =
      state.firstEquitySeen *
      CONFIG.equityFloorPct;

    if(equity <= floor){
      state.halted = true;
      state.haltReason = "equity_floor_breach";
    }

    if(state.dailyStartEquity > 0){

      const dailyLoss =
        (state.dailyStartEquity - equity) /
        state.dailyStartEquity;

      if(dailyLoss >= CONFIG.maxDailyLossPct){
        state.halted = true;
        state.haltReason = "daily_loss_limit";
      }

    }

  }

  /* =====================================================
  LOSS CLUSTER COOL-DOWN
  ===================================================== */

  if(trades.length >= CONFIG.lossClusterSize &&
     trades.length !== state.lastClusterTradeCount){

    const recent =
      trades.slice(-CONFIG.lossClusterSize);

    const allLoss =
      recent.every(t=>t.profit <= 0);

    if(allLoss){

      state.cooldownLevel++;

      const cooldown =
        CONFIG.baseCooldownMs *
        Math.pow(1.8,state.cooldownLevel-1);

      state.cooldownUntil = ts + cooldown;

    }

    state.lastClusterTradeCount = trades.length;

  }

  const cooling = ts < state.cooldownUntil;

  /* =====================================================
  VOLATILITY REGIME
  ===================================================== */

  if(volatility >= CONFIG.highVolatilityCutoff)
    state.volatilityRegime="high";
  else if(volatility <= CONFIG.lowVolatilityCutoff)
    state.volatilityRegime="low";
  else
    state.volatilityRegime="normal";

  let riskMultiplier = 1;

  if(state.volatilityRegime === "high")
    riskMultiplier *= isPaper ? 0.85 : 0.65;

  if(state.volatilityRegime === "low")
    riskMultiplier *= isPaper ? 1.25 : 1.15;

  /* =====================================================
  DRAWDOWN RISK REDUCTION
  ===================================================== */

  if(rollingDrawdown > 0.10)
    riskMultiplier *= 0.75;

  if(rollingDrawdown > 0.18)
    riskMultiplier *= 0.55;

  /* =====================================================
  MARGIN PROTECTION (LIVE ONLY)
  ===================================================== */

  if(!isPaper){

    let marginPressure = 0;

    if(marginUsed > 0 && equity > 0)
      marginPressure = marginUsed / equity;

    state.lastMarginPressure = marginPressure;

    if(marginPressure >= CONFIG.maxMarginUtilization){

      state.halted = true;
      state.haltReason = "margin_utilization_limit";

    }

    if(
      maintenanceRequired > 0 &&
      equity <= maintenanceRequired *
      (1 + CONFIG.liquidationBufferPct)
    ){
      riskMultiplier *= 0.25;
    }

  }

  return{
    halted:isPaper ? false : state.halted,
    haltReason:isPaper ? null : state.haltReason,
    cooling,
    riskMultiplier:clamp(riskMultiplier,0.25,1.6),
    drawdown,
    rollingDrawdown,
    volatilityRegime:state.volatilityRegime,
    cooldownLevel:state.cooldownLevel,
    marginPressure:state.lastMarginPressure,
    mode:isPaper ? "paper-learning" : "live-capital"
  };

}

function resetTenant(tenantId){
  RISK_STATE.delete(tenantId);
}

module.exports={
  evaluate,
  resetTenant
};
