// ==========================================================
// Institutional Portfolio Engine
// Multi-Asset Allocation + Risk Enforcement
// ==========================================================

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({

  maxTotalExposurePct:
    Number(process.env.PORTFOLIO_MAX_TOTAL_EXPOSURE || 0.8),

  maxSingleAssetPct:
    Number(process.env.PORTFOLIO_MAX_SINGLE_ASSET || 0.3),

  correlationCutoff:
    Number(process.env.PORTFOLIO_CORRELATION_CUTOFF || 0.9),

  minCapitalBufferPct:
    Number(process.env.PORTFOLIO_MIN_BUFFER || 0.1),

  maxCapitalVelocityPct:
    Number(process.env.PORTFOLIO_MAX_VELOCITY || 0.5),

  velocityWindowMs:
    Number(process.env.PORTFOLIO_VELOCITY_WINDOW || 300000),

});

/* =========================================================
PORTFOLIO STATE
========================================================= */

const PORTFOLIO = new Map();

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!PORTFOLIO.has(key)){

    PORTFOLIO.set(key,{
      capital:0,
      exposureBySymbol:{},
      totalExposure:0,
      capitalDeployments:[],
      allocation:{},
      lastUpdated:Date.now()
    });

  }

  return PORTFOLIO.get(key);

}

/* =========================================================
ASSET SECTOR
========================================================= */

function getSector(symbol){

  if(!symbol) return "other";

  if(symbol.includes("BTC")) return "crypto_major";
  if(symbol.includes("ETH")) return "crypto_major";
  if(symbol.includes("SOL")) return "crypto_alt";

  if(symbol.includes("EUR") || symbol.includes("GBP"))
    return "forex";

  if(symbol.includes("SPX") || symbol.includes("NAS"))
    return "index";

  if(symbol.includes("XAU"))
    return "commodity";

  return "other";

}

/* =========================================================
CORRELATION MODEL
========================================================= */

function estimateCorrelation(a,b){

  if(a===b) return 1;

  const sa=getSector(a);
  const sb=getSector(b);

  if(sa===sb) return 0.75;

  return 0.35;

}

/* =========================================================
PORTFOLIO ALLOCATION ENGINE
========================================================= */

function computeAllocation(symbols){

  const allocation={};

  const crypto = symbols.filter(s=>s.includes("BTC")||s.includes("ETH")||s.includes("SOL"));
  const forex = symbols.filter(s=>s.includes("EUR")||s.includes("GBP"));
  const index = symbols.filter(s=>s.includes("SPX")||s.includes("NAS"));
  const commodity = symbols.filter(s=>s.includes("XAU"));

  /* BASE ALLOCATION */

  const weights={
    crypto:0.45,
    forex:0.20,
    index:0.20,
    commodity:0.15
  };

  crypto.forEach(s=>allocation[s]=weights.crypto/crypto.length);
  forex.forEach(s=>allocation[s]=weights.forex/forex.length);
  index.forEach(s=>allocation[s]=weights.index/index.length);
  commodity.forEach(s=>allocation[s]=weights.commodity/commodity.length);

  return allocation;

}

/* =========================================================
REBUILD EXPOSURE
========================================================= */

function rebuildExposure(state,tradingState){

  state.exposureBySymbol={};
  state.totalExposure=0;

  if(!tradingState) return;

  if(tradingState.positions){

    for(const [symbol,pos] of Object.entries(tradingState.positions)){

      if(!pos?.qty || !tradingState.lastPrices?.[symbol])
        continue;

      const price = tradingState.lastPrices[symbol];
      const notional = Math.abs(pos.qty*price);

      state.exposureBySymbol[symbol]=notional;
      state.totalExposure += notional;

    }

  }

}

/* =========================================================
VELOCITY CONTROL
========================================================= */

function checkVelocity(state,amount,ts){

  const windowStart = ts-CONFIG.velocityWindowMs;

  state.capitalDeployments =
    state.capitalDeployments.filter(d=>d.ts>=windowStart);

  const deployed =
    state.capitalDeployments.reduce((a,b)=>a+b.amount,0);

  if(
    deployed+amount >
    state.capital*CONFIG.maxCapitalVelocityPct
  ){
    return false;
  }

  state.capitalDeployments.push({ts,amount});

  return true;

}

/* =========================================================
CORE PORTFOLIO DECISION
========================================================= */

function evaluate({
  tenantId,
  symbol,
  equity,
  proposedRiskPct,
  paperState,
  ts = Date.now()
}){

  const state = getState(tenantId);

  state.capital = equity || state.capital;

  rebuildExposure(state,paperState);

  const riskPct = clamp(proposedRiskPct||0,0,1);

  const projectedNotional =
    state.capital*riskPct;

  const projectedTotal =
    state.totalExposure+projectedNotional;

  /* ================= BUFFER ================= */

  const capitalBuffer =
    state.capital*CONFIG.minCapitalBufferPct;

  if(state.capital-projectedTotal <= capitalBuffer){
    return reject("Capital buffer protection");
  }

  /* ================= PORTFOLIO CAP ================= */

  if(
    projectedTotal >
    state.capital*CONFIG.maxTotalExposurePct
  ){
    return reject("Portfolio exposure limit");
  }

  /* ================= SINGLE ASSET ================= */

  const projectedAsset =
    (state.exposureBySymbol[symbol]||0)+projectedNotional;

  if(
    projectedAsset >
    state.capital*CONFIG.maxSingleAssetPct
  ){
    return reject("Asset allocation cap");
  }

  /* ================= CORRELATION ================= */

  for(const existing of Object.keys(state.exposureBySymbol)){

    if(existing===symbol) continue;

    const corr =
      estimateCorrelation(existing,symbol);

    if(corr >= CONFIG.correlationCutoff){
      return reject("Correlation protection");
    }

  }

  /* ================= VELOCITY ================= */

  if(!checkVelocity(state,projectedNotional,ts)){
    return reject("Capital velocity exceeded");
  }

  state.lastUpdated=ts;

  return{
    allow:true,
    reason:"Portfolio approved",
    adjustedRiskPct:riskPct
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
GET PORTFOLIO ALLOCATION
========================================================= */

function getAllocation(symbols){

  return computeAllocation(symbols);

}

/* =========================================================
RESET
========================================================= */

function resetTenant(id){
  PORTFOLIO.delete(id);
}

module.exports={
  evaluate,
  getAllocation,
  resetTenant
};
