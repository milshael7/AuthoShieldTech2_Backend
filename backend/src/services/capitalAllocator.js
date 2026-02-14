// backend/src/services/capitalAllocator.js
// Phase 22 — Institutional Capital Allocator
// Dynamic Risk Scaling • Equity Curve Adaptive • Margin Aware

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  baseRisk: Number(process.env.CAPITAL_BASE_RISK || 0.01),
  maxRisk: Number(process.env.CAPITAL_MAX_RISK || 0.05),
  minRisk: Number(process.env.CAPITAL_MIN_RISK || 0.002),

  drawdownPenalty: 0.5,
  marginPenaltyThreshold: 0.6,
  highVolatilityPenalty: 0.7,
});

/* =========================================================
   EQUITY CURVE ANALYSIS
========================================================= */

function computeDrawdown(state) {
  if (!state.equityPeak) {
    state.equityPeak = state.equity;
  }

  state.equityPeak = Math.max(
    state.equityPeak,
    state.equity
  );

  if (!state.equityPeak) return 0;

  return (
    (state.equityPeak - state.equity) /
    state.equityPeak
  );
}

/* =========================================================
   CORE ALLOCATION
========================================================= */

function allocate({
  state,
  fusedSignal,
  plan,
}) {
  let risk = CONFIG.baseRisk;

  /* === 1️⃣ Signal Strength Scaling === */

  if (fusedSignal?.score) {
    const strength = Math.abs(fusedSignal.score);

    if (strength > 2) risk *= 1.5;
    else if (strength < 1) risk *= 0.7;
  }

  /* === 2️⃣ Confidence Scaling === */

  if (plan?.confidence) {
    risk *= clamp(plan.confidence, 0.5, 1.5);
  }

  /* === 3️⃣ Drawdown Protection === */

  const dd = computeDrawdown(state);

  if (dd > 0.1) {
    risk *= CONFIG.drawdownPenalty;
  }

  /* === 4️⃣ Margin Stress Protection === */

  if (
    state.marginUsed &&
    state.equity > 0 &&
    state.marginUsed / state.equity >
      CONFIG.marginPenaltyThreshold
  ) {
    risk *= 0.5;
  }

  /* === 5️⃣ Volatility Protection === */

  if (state.volatility && state.volatility > 0.02) {
    risk *= CONFIG.highVolatilityPenalty;
  }

  return clamp(
    risk,
    CONFIG.minRisk,
    CONFIG.maxRisk
  );
}

module.exports = {
  allocate,
};
