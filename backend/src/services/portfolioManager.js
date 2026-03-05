// backend/src/services/portfolioManager.js
// ==========================================================
// Institutional Portfolio Engine (Stable Version)
// Supports Single-Position + Multi-Position Systems
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({
  maxTotalExposurePct: Number(process.env.PORTFOLIO_MAX_TOTAL_EXPOSURE || 0.8),
  maxSingleAssetPct: Number(process.env.PORTFOLIO_MAX_SINGLE_ASSET || 0.3),

  correlationCutoff: Number(process.env.PORTFOLIO_CORRELATION_CUTOFF || 0.9),

  minCapitalBufferPct: Number(process.env.PORTFOLIO_MIN_BUFFER || 0.1),

  maxCapitalVelocityPct: Number(process.env.PORTFOLIO_MAX_VELOCITY || 0.5),
  velocityWindowMs: Number(process.env.PORTFOLIO_VELOCITY_WINDOW || 300000),

  maxSectorExposurePct: Number(process.env.PORTFOLIO_MAX_SECTOR || 0.6),
  maxMarginUtilizationPct: Number(process.env.PORTFOLIO_MAX_MARGIN_UTIL || 0.7),
});

/* =========================================================
TENANT STATE
========================================================= */

const PORTFOLIO = new Map();

function getState(tenantId) {

  const key = tenantId || "__default__";

  if (!PORTFOLIO.has(key)) {

    PORTFOLIO.set(key,{
      capital:0,
      exposureBySymbol:{},
      exposureBySector:{},
      totalExposure:0,
      grossExposure:0,
      netExposure:0,
      capitalDeployments:[],
      lastUpdated:Date.now()
    });

  }

  return PORTFOLIO.get(key);

}

/* =========================================================
SECTOR MODEL
========================================================= */

function getSector(symbol){

  if(!symbol) return "other";

  if(symbol.includes("BTC") || symbol.includes("ETH"))
    return "majors";

  if(symbol.includes("SOL") || symbol.includes("ADA"))
    return "layer1";

  if(symbol.includes("XRP") || symbol.includes("XLM"))
    return "payments";

  return "alt";

}

/* =========================================================
CORRELATION MODEL
========================================================= */

function estimateCorrelation(symbolA,symbolB){

  if(!symbolA || !symbolB) return 0;

  if(symbolA === symbolB) return 1;

  const sectorA = getSector(symbolA);
  const sectorB = getSector(symbolB);

  if(sectorA === sectorB)
    return 0.75;

  return 0.45;

}

/* =========================================================
EXPOSURE REBUILD
Supports:
• single position engines
• multi position engines
========================================================= */

function recalcExposureFromState(tradingState,state){

  state.exposureBySymbol = {};
  state.exposureBySector = {};
  state.totalExposure = 0;
  state.grossExposure = 0;
  state.netExposure = 0;

  if(!tradingState) return;

  /* ===== SINGLE POSITION ENGINE ===== */

  if(tradingState.position && tradingState.lastPrice){

    const pos = tradingState.position;
    const price = tradingState.lastPrice;

    const notional = Math.abs(pos.qty * price);

    state.exposureBySymbol[pos.symbol] = notional;

    const sector = getSector(pos.symbol);

    state.exposureBySector[sector] =
      (state.exposureBySector[sector] || 0) + notional;

    state.totalExposure += notional;
    state.grossExposure += notional;
    state.netExposure += pos.qty * price;

    return;
  }

  /* ===== MULTI POSITION ENGINE ===== */

  if(tradingState.positions){

    for(const [symbol,pos] of Object.entries(tradingState.positions)){

      if(!pos?.qty || !tradingState.lastPrices?.[symbol])
        continue;

      const price = tradingState.lastPrices[symbol];

      const notional = Math.abs(pos.qty * price);

      state.exposureBySymbol[symbol] = notional;

      const sector = getSector(symbol);

      state.exposureBySector[sector] =
        (state.exposureBySector[sector] || 0) + notional;

      state.totalExposure += notional;
      state.grossExposure += notional;
      state.netExposure += pos.qty * price;

    }

  }

}

/* =========================================================
CAPITAL VELOCITY
========================================================= */

function checkVelocity(state,projectedNotional,ts){

  const windowStart = ts - CONFIG.velocityWindowMs;

  state.capitalDeployments =
    state.capitalDeployments.filter(d=>d.ts >= windowStart);

  const deployedRecently =
    state.capitalDeployments.reduce((a,b)=>a+b.amount,0);

  if(
    deployedRecently + projectedNotional >
    state.capital * CONFIG.maxCapitalVelocityPct
  ){
    return false;
  }

  state.capitalDeployments.push({
    ts,
    amount:projectedNotional
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
  marginUsed = 0,
  ts = Date.now()
}){

  const state = getState(tenantId);

  state.capital = equity || state.capital;

  recalcExposureFromState(paperState,state);

  const riskPct = clamp(proposedRiskPct || 0,0,1);

  const projectedNotional =
    state.capital * riskPct;

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

  /* ================= CAPITAL BUFFER ================= */

  if(state.capital - projectedTotal <= capitalBuffer){
    return reject("Capital buffer protection");
  }

  /* ================= TOTAL EXPOSURE ================= */

  if(
    projectedTotal >=
    state.capital * CONFIG.maxTotalExposurePct
  ){
    return reject("Max portfolio exposure reached");
  }

  /* ================= SINGLE ASSET ================= */

  if(
    projectedAsset >=
    state.capital * CONFIG.maxSingleAssetPct
  ){
    return reject("Single asset cap reached");
  }

  /* ================= SECTOR ================= */

  if(
    projectedSector >=
    state.capital * CONFIG.maxSectorExposurePct
  ){
    return reject("Sector exposure cap reached");
  }

  /* ================= CORRELATION ================= */

  for(const existing of Object.keys(state.exposureBySymbol)){

    if(existing === symbol) continue;

    const corr =
      estimateCorrelation(existing,symbol);

    if(corr >= CONFIG.correlationCutoff){
      return reject("High correlation exposure");
    }

  }

  /* ================= MARGIN ================= */

  if(
    marginUsed > 0 &&
    marginUsed / state.capital >
      CONFIG.maxMarginUtilizationPct
  ){
    return reject("Margin utilization too high");
  }

  /* ================= VELOCITY ================= */

  if(!checkVelocity(state,projectedNotional,ts)){
    return reject("Capital velocity exceeded");
  }

  state.lastUpdated = ts;

  return{
    allow:true,
    reason:"Approved",
    adjustedRiskPct:clamp(
      riskPct,
      0,
      CONFIG.maxSingleAssetPct
    )
  };

  function reject(reason){
    return{
      allow:false,
      reason,
      adjustedRiskPct:0
    };
  }

}

/* =========================================================
RESET
========================================================= */

function resetTenant(tenantId){
  PORTFOLIO.delete(tenantId);
}

module.exports={
  evaluate,
  resetTenant
};
