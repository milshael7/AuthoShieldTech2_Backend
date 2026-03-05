// backend/src/services/correlationEngine.js
// Multi-Asset Correlation Intelligence Engine

const CORRELATION = new Map();

const MAX_HISTORY = 120;

/* =====================================================
STATE
===================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!CORRELATION.has(key)){

    CORRELATION.set(key,{
      markets:{}
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

  if(!state.markets[symbol]){

    state.markets[symbol] = [];

  }

  state.markets[symbol].push({
    price,
    ts:Date.now()
  });

  if(state.markets[symbol].length > MAX_HISTORY)
    state.markets[symbol].shift();

}

/* =====================================================
CALCULATE CORRELATION
===================================================== */

function computeCorrelation(a,b){

  const n = Math.min(a.length,b.length);

  if(n < 10)
    return 0;

  let sumA=0,sumB=0,sumAB=0,sumA2=0,sumB2=0;

  for(let i=0;i<n;i++){

    const x = a[i].price;
    const y = b[i].price;

    sumA += x;
    sumB += y;

    sumAB += x*y;

    sumA2 += x*x;
    sumB2 += y*y;

  }

  const numerator =
    (n*sumAB)-(sumA*sumB);

  const denominator =
    Math.sqrt(
      (n*sumA2-sumA*sumA) *
      (n*sumB2-sumB*sumB)
    );

  if(denominator===0)
    return 0;

  return numerator/denominator;

}

/* =====================================================
GET CORRELATION BOOST
===================================================== */

function getCorrelationBoost({
  tenantId,
  symbol
}){

  const state = getState(tenantId);

  const symbols =
    Object.keys(state.markets);

  if(symbols.length < 2)
    return 1;

  const base =
    state.markets[symbol];

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

  if(strongest > 0.8)
    return 1.2;

  if(strongest < 0.3)
    return 0.9;

  return 1;

}

module.exports={
  recordPrice,
  getCorrelationBoost
};
