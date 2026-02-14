// backend/src/services/portfolioManager.js
// Phase 7 — Institutional Portfolio Engine
// Multi-Asset Exposure Control • Correlation Control • Capital Allocation Layer
// Sits ABOVE strategyEngine & riskManager
// Tenant Safe

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxTotalExposurePct: Number(process.env.PORTFOLIO_MAX_TOTAL_EXPOSURE || 0.8), // 80% capital deployed max
  maxSingleAssetPct: Number(process.env.PORTFOLIO_MAX_SINGLE_ASSET || 0.3),     // 30% per asset
  correlationCutoff: Number(process.env.PORTFOLIO_CORRELATION_CUTOFF || 0.8),
  minCapitalBufferPct: Number(process.env.PORTFOLIO_MIN_BUFFER || 0.1),         // 10% reserve
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
   CORRELATION MODEL (LIGHTWEIGHT PLACEHOLDER)
   In future: rolling correlation matrix
========================================================= */

function estimateCorrelation(symbolA, symbolB) {
  if (!symbolA || !symbolB) return 0;
  if (symbolA === symbolB) return 1;

  // crude crypto sector clustering
  const majors = ["BTCUSDT", "ETHUSDT"];
  if (majors.includes(symbolA) && majors.includes(symbolB)) return 0.9;

  return 0.6; // default moderate correlation
}

/* =========================================================
   EXPOSURE CALCULATION
========================================================= */

function calculateExposure(paperState) {
  if (!paperState) return 0;

  if (!paperState.position) return 0;

  const pos = paperState.position;
  const notional = pos.qty * paperState.lastPrice;

  return Math.abs(notional);
}

/* =========================================================
   CORE EVALUATION
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

  const currentExposure = calculateExposure(paperState);
  state.exposureBySymbol[symbol] = currentExposure;

  const totalExposure = Object.values(state.exposureBySymbol)
    .reduce((a, b) => a + b, 0);

  state.totalExposure = totalExposure;

  const capitalBuffer = state.capital * CONFIG.minCapitalBufferPct;

  /* ---------------- Capital Guard ---------------- */

  if (state.capital - totalExposure <= capitalBuffer) {
    return {
      allow: false,
      reason: "Capital buffer protection",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Total Exposure Guard ---------------- */

  if (
    totalExposure >=
    state.capital * CONFIG.maxTotalExposurePct
  ) {
    return {
      allow: false,
      reason: "Max portfolio exposure reached",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Single Asset Guard ---------------- */

  const assetExposure = state.exposureBySymbol[symbol] || 0;

  if (
    assetExposure >=
    state.capital * CONFIG.maxSingleAssetPct
  ) {
    return {
      allow: false,
      reason: "Single asset cap reached",
      adjustedRiskPct: 0,
    };
  }

  /* ---------------- Correlation Guard ---------------- */

  for (const existingSymbol of Object.keys(
    state.exposureBySymbol
  )) {
    if (!state.exposureBySymbol[existingSymbol]) continue;

    const corr = estimateCorrelation(
      existingSymbol,
      symbol
    );

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
