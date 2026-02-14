// backend/src/services/portfolioManager.js
// Phase 8 — Institutional Portfolio Engine (Upgraded)
// Multi-Asset Exposure • Projected Exposure Model • Correlation Control
// Fully Compatible with PaperTrader + LiveTrader
// Tenant Safe

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxTotalExposurePct: Number(process.env.PORTFOLIO_MAX_TOTAL_EXPOSURE || 0.8),
  maxSingleAssetPct: Number(process.env.PORTFOLIO_MAX_SINGLE_ASSET || 0.3),
  correlationCutoff: Number(process.env.PORTFOLIO_CORRELATION_CUTOFF || 0.8),
  minCapitalBufferPct: Number(process.env.PORTFOLIO_MIN_BUFFER || 0.1),
});

/* =========================================================
   TENANT PORTFOLIO STATE
========================================================= */

const PORTFOLIO = new Map();

function getState(tenantId) {
  const key = tenantId || "__default__";

  if (!PORTFOLIO.has(key)) {
    PORTFOLIO.set(key, {
      exposureBySymbol: {},
      totalExposure: 0,
      capital: 0,
      lastUpdated: Date.now(),
    });
  }

  return PORTFOLIO.get(key);
}

/* =========================================================
   CORRELATION MODEL (Lightweight placeholder)
========================================================= */

function estimateCorrelation(symbolA, symbolB) {
  if (!symbolA || !symbolB) return 0;
  if (symbolA === symbolB) return 1;

  const majors = ["BTCUSDT", "ETHUSDT"];
  if (majors.includes(symbolA) && majors.includes(symbolB)) return 0.9;

  return 0.6;
}

/* =========================================================
   EXPOSURE CALCULATION
========================================================= */

function calculateExposureFromState(paperState) {
  if (!paperState) return 0;

  if (!paperState.position) return 0;

  const pos = paperState.position;
  if (!paperState.lastPrice || !pos.qty) return 0;

  return Math.abs(pos.qty * paperState.lastPrice);
}

/* =========================================================
   CORE EVALUATION (PROJECTED MODEL)
========================================================= */

function evaluate({
  tenantId,
  symbol,
  equity,
  proposedRiskPct,
  paperState,
}) {
  const state = getState(tenantId);

  state.capital = equity || state.capital;

  const currentExposure = calculateExposureFromState(paperState);
  state.exposureBySymbol[symbol] = currentExposure;

  const totalExposure = Object.values(state.exposureBySymbol)
    .reduce((a, b) => a + b, 0);

  state.totalExposure = totalExposure;

  const projectedNotional =
    state.capital * clamp(proposedRiskPct || 0, 0, 1);

  const projectedTotalExposure = totalExposure + projectedNotional;
  const projectedAssetExposure =
    (state.exposureBySymbol[symbol] || 0) + projectedNotional;

  const capitalBuffer = state.capital * CONFIG.minCapitalBufferPct;

  /* ---------------- Capital Buffer Guard ---------------- */

  if (state.capital - projectedTotalExposure <= capitalBuffer) {
    return {
      allow: false,
      reason: "Capital buffer protection",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Total Exposure Guard ---------------- */

  if (
    projectedTotalExposure >=
    state.capital * CONFIG.maxTotalExposurePct
  ) {
    return {
      allow: false,
      reason: "Max portfolio exposure reached",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Single Asset Guard ---------------- */

  if (
    projectedAssetExposure >=
    state.capital * CONFIG.maxSingleAssetPct
  ) {
    return {
      allow: false,
      reason: "Single asset cap reached",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Correlation Guard ---------------- */

  for (const existingSymbol of Object.keys(state.exposureBySymbol)) {
    const exposure = state.exposureBySymbol[existingSymbol];
    if (!exposure || existingSymbol === symbol) continue;

    const corr = estimateCorrelation(existingSymbol, symbol);

    if (corr >= CONFIG.correlationCutoff) {
      return {
        allow: false,
        reason: "High correlation exposure",
        adjustedRiskPct: 0,
      };
    }
  }

  /* ---------------- Approved ---------------- */

  const adjustedRiskPct = clamp(
    proposedRiskPct,
    0,
    CONFIG.maxSingleAssetPct
  );

  state.lastUpdated = Date.now();

  return {
    allow: true,
    reason: "Approved",
    adjustedRiskPct,
  };
}

/* =========================================================
   RESET
========================================================= */

function resetTenant(tenantId) {
  PORTFOLIO.delete(tenantId);
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  evaluate,
  resetTenant,
};
