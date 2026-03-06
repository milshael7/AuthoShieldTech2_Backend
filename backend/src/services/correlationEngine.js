// ======================================================
// Institutional Correlation Intelligence Engine
// Multi-Asset Correlation + Regime Awareness
// Deterministic • Crash Safe • Analytics Ready
// ======================================================

const CORRELATION = new Map();

const MAX_HISTORY = 120;

/* =====================================================
STATE
===================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!CORRELATION.has(key)){

    CORRELATION.set(key,{
      markets:{},
      cache:{},
      lastUpdate:0
    });

  }

  return CORRELATION.get(key);

}

/* =====================================================
RECORD MARKET PRICE
===================================================== */

function recordPrice({
  tenantId,
  symbol,
  price
}){

  const state = getState(tenantId);

  if(!state.markets[symbol])
    state.markets[symbol] = [];

  state.markets[symbol].push({
    price,
    ts:Date.now()
  });

  if(state.markets[symbol].length > MAX_HISTORY)
    state.markets[symbol].shift();

}

/* =====================================================
RETURNS SERIES
===================================================== */

function computeReturns(series){

  const returns = [];

  for(let i=1;i<series.length;i++){

    const prev = series[i-1].price;
    const cur  = series[i].price;

    if(prev>0)
      returns.push((cur-prev)/prev);

  }

  return returns;

}

/* =====================================================
PEARSON CORRELATION
===================================================== */

function computeCorrelation(a,b){

  const rA = computeReturns(a);
  const rB = computeReturns(b);

  const n = Math.min(rA.length,rB.length);

  if(n < 8)
    return 0;

  let sumA=0,sumB=0,sumAB=0,sumA2=0,sumB2=0;

  for(let i=0;i<n;i++){

    const x = rA[i];
    const y = rB[i];

    sumA+=x;
    sumB+=y;

    sumAB+=x*y;

    sumA2+=x*x;
    sumB2+=y*y;

  }

  const numerator =
    (n*sumAB)-(sumA*sumB);

  const denominator =
    Math.sqrt(
      (n*sumA2-sumA*sumA) *
      (n*sumB2-sumB*sumB)
    );

  if(!denominator || !Number.isFinite(denominator))
    return 0;

  return numerator/denominator;

}

/* =====================================================
CORRELATION BOOST MODEL
===================================================== */

function getCorrelationBoost({
  tenantId,
  symbol
}){

  const state = getState(tenantId);

  const symbols = Object.keys(state.markets);

  if(symbols.length < 2)
    return 1;

  const base = state.markets[symbol];

  if(!base)
    return 1;

  let strongest = 0;

  for(const s of symbols){

    if(s===symbol)
      continue;

    const corr =
      computeCorrelation(
        base,
        state.markets[s]
      );

    strongest =
      Math.max(
        strongest,
        Math.abs(corr)
      );

  }

  /* ================= BOOST MODEL ================= */

  if(strongest > 0.85)
    return 1.15;

  if(strongest > 0.65)
    return 1.05;

  if(strongest < 0.25)
    return 0.9;

  return 1;

}

/* =====================================================
CORRELATION MATRIX (for analytics UI)
===================================================== */

function getMatrix(tenantId){

  const state = getState(tenantId);

  const symbols =
    Object.keys(state.markets);

  const matrix={};

  for(const a of symbols){

    matrix[a]={};

    for(const b of symbols){

      if(a===b){

        matrix[a][b]=1;
        continue;

      }

      matrix[a][b] =
        computeCorrelation(
          state.markets[a],
          state.markets[b]
        );

    }

  }

  return matrix;

}

/* =====================================================
RESET
===================================================== */

function resetTenant(tenantId){

  CORRELATION.delete(tenantId);

}

module.exports = {
  recordPrice,
  getCorrelationBoost,
  getMatrix,
  resetTenant
};
