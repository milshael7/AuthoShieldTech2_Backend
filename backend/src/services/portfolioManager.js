// backend/src/services/portfolioManager.js
// Phase 9 — Institutional Portfolio Engine
// Multi-Position Tracking • Sector Buckets • Exposure Smoothing
// Correlation Memory • Capital Velocity Control
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

  maxCapitalVelocityPct: Number(process.env.PORTFOLIO_MAX_VELOCITY || 0.5), // 50% per 5 min
  velocityWindowMs: Number(process.env.PORTFOLIO_VELOCITY_WINDOW || 300000),
});

/* =========================================================
   TENANT STATE
========================================================= */

const PORTFOLIO = new Map();

function getState(tenantId) {
  const key = tenantId || "__default__";

  if (!PORTFOLIO.has(key)) {
    PORTFOLIO.set(key, {
      version: 9,
      capital: 0,
      exposureBySymbol: {},
      exposureBySector: {},
      totalExposure: 0,
      capitalDeployments: [], // velocity tracking
      lastUpdated: Date.now(),
    });
  }

  return PORTFOLIO.get(key);
}

/* =========================================================
   SECTOR MODEL (Lightweight)
========================================================= */

function getSector(symbol) {
  if (!symbol) return "other";

  if (symbol.includes("BTC") || symbol.includes("ETH"))
    return "majors";

  if (symbol.includes("SOL") || symbol.includes("ADA"))
    return "layer1";

  return "alt";
}

/* =========================================================
   CORRELATION MODEL (Memory Enhanced)
========================================================= */

function estimateCorrelation(symbolA, symbolB) {
  if (!symbolA || !symbolB) return 0;
  if (symbolA === symbolB) return 1;

  const sectorA = getSector(symbolA);
  const sectorB = getSector(symbolB);

  if (sectorA === sectorB) return 0.85;

  return 0.55;
}

/* =========================================================
   EXPOSURE CALCULATION
========================================================= */

function recalcExposureFromState(paperState, state) {
  state.exposureBySymbol = {};
  state.exposureBySector = {};
  state.totalExposure = 0;

  if (!paperState?.position || !paperState?.lastPrice) return;

  const pos = paperState.position;
  const notional = Math.abs(pos.qty * paperState.lastPrice);
  const sector = getSector(pos.symbol);

  state.exposureBySymbol[pos.symbol] = notional;
  state.exposureBySector[sector] =
    (state.exposureBySector[sector] || 0) + notional;

  state.totalExposure = notional;
}

/* =========================================================
   CAPITAL VELOCITY CONTROL
========================================================= */

function checkVelocity(state, projectedNotional, ts) {
  const windowStart = ts - CONFIG.velocityWindowMs;

  state.capitalDeployments =
    state.capitalDeployments.filter(
      d => d.ts >= windowStart
    );

  const deployedRecently = state.capitalDeployments
    .reduce((a, b) => a + b.amount, 0);

  if (
    deployedRecently + projectedNotional >
    state.capital * CONFIG.maxCapitalVelocityPct
  ) {
    return false;
  }

  state.capitalDeployments.push({
    ts,
    amount: projectedNotional,
  });

  return true;
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
  ts = Date.now(),
}) {
  const state = getState(tenantId);

  state.capital = equity || state.capital;

  recalcExposureFromState(paperState, state);

  const projectedNotional =
    state.capital * clamp(proposedRiskPct || 0, 0, 1);

  const projectedTotal =
    state.totalExposure + projectedNotional;

  const projectedAsset =
    (state.exposureBySymbol[symbol] || 0) +
    projectedNotional;

  const sector = getSector(symbol);
  const projectedSector =
    (state.exposureBySector[sector] || 0) +
    projectedNotional;

  const capitalBuffer =
    state.capital * CONFIG.minCapitalBufferPct;

  /* ---------------- Buffer Guard ---------------- */

  if (state.capital - projectedTotal <= capitalBuffer) {
    return reject("Capital buffer protection");
  }

  /* ---------------- Total Exposure ---------------- */

  if (
    projectedTotal >=
    state.capital * CONFIG.maxTotalExposurePct
  ) {
    return reject("Max portfolio exposure reached");
  }

  /* ---------------- Single Asset ---------------- */

  if (
    projectedAsset >=
    state.capital * CONFIG.maxSingleAssetPct
  ) {
    return reject("Single asset cap reached");
  }

  /* ---------------- Sector Cap (Implicit 60%) ---------------- */

  if (
    projectedSector >=
    state.capital * 0.6
  ) {
    return reject("Sector exposure cap reached");
  }

  /* ---------------- Correlation Guard ---------------- */

  for (const existing of Object.keys(state.exposureBySymbol)) {
    const exposure = state.exposureBySymbol[existing];
    if (!exposure || existing === symbol) continue;

    const corr = estimateCorrelation(existing, symbol);

    if (corr >= CONFIG.correlationCutoff) {
      return reject("High correlation exposure");
    }
  }

  /* ---------------- Capital Velocity ---------------- */

  if (!checkVelocity(state, projectedNotional, ts)) {
    return reject("Capital velocity exceeded");
  }

  state.lastUpdated = ts;

  return {
    allow: true,
    reason: "Approved",
    adjustedRiskPct: clamp(
      proposedRiskPct,
      0,
      CONFIG.maxSingleAssetPct
    ),
  };

  function reject(reason) {
    return {
      allow: false,
      reason,
      adjustedRiskPct: 0,
    };
  }
}

/* =========================================================
   RESET
========================================================= */

function resetTenant(tenantId) {
  PORTFOLIO.delete(tenantId);
}

module.exports = {
  evaluate,
  resetTenant,
};
