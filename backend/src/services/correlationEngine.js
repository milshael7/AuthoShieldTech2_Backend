// ======================================================
// Institutional Correlation Intelligence Engine v2.1
// Multi-Asset Correlation + Market Leadership + Liquidity
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

  const returns=[];

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
MARKET LEADER DETECTION
===================================================== */

function detectLeader(state){

  const symbols =
    Object.keys(state.markets);

  let leader=null;
  let strongestMove=0;

  for(const s of symbols){

    const series = state.markets[s];

    if(series.length < 5)
      continue;

    const first =
      series[series.length-5].price;

    const last =
      series[series.length-1].price;

    const move =
      Math.abs((last-first)/first);

    if(move > strongestMove){

      strongestMove = move;
      leader = s;

    }

  }

  return leader;

}

/* =====================================================
RISK REGIME DETECTION
===================================================== */

function detectRiskRegime(state){

  const markets = state.markets;

  const btc = markets["BTC"] || markets["BTCUSDT"];
  const spy = markets["SPY"];
  const dxy = markets["DXY"];

  if(!btc || btc.length<5)
    return "neutral";

  const btcMove =
    (btc[btc.length-1].price - btc[btc.length-5].price) /
    btc[btc.length-5].price;

  let spyMove=0;
  let dxyMove=0;

  if(spy && spy.length>=5){

    spyMove =
      (spy[spy.length-1].price - spy[spy.length-5].price) /
      spy[spy.length-5].price;

  }

  if(dxy && dxy.length>=5){

    dxyMove =
      (dxy[dxy.length-1].price - dxy[dxy.length-5].price) /
      dxy[dxy.length-5].price;

  }

  if(btcMove>0 && spyMove>0)
    return "risk_on";

  if(btcMove<0 && dxyMove>0)
    return "risk_off";

  return "neutral";

}

/* =====================================================
CORRELATION BOOST MODEL
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

  if(strongest > 0.85)
    return 1.15;

  if(strongest > 0.65)
    return 1.05;

  if(strongest < 0.25)
    return 0.9;

  return 1;

}

/* =====================================================
CORRELATION MATRIX (Analytics)
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
INTELLIGENCE SNAPSHOT
===================================================== */

function getMarketIntelligence(tenantId){

  const state = getState(tenantId);

  return{
    leader: detectLeader(state),
    regime: detectRiskRegime(state),
    matrix: getMatrix(tenantId)
  };

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
  getMarketIntelligence,
  resetTenant
};
