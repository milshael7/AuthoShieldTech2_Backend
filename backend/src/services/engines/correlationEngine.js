// Phase 23 — Institutional Correlation Engine
// Portfolio Correlation Risk Model
// Rolling Correlation • Beta Exposure • Risk Throttling

/* =========================================================
   CONFIG
========================================================= */

const MAX_HISTORY = 300;
const CORRELATION_LOOKBACK = 100;

const MAX_PORTFOLIO_CORRELATION =
  Number(process.env.MAX_PORTFOLIO_CORRELATION || 0.85);

const CORRELATION_RISK_MULTIPLIER =
  Number(process.env.CORRELATION_RISK_MULTIPLIER || 0.5);

/* =========================================================
   HELPERS
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, avg) {
  const variance =
    arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) /
    arr.length;
  return Math.sqrt(variance);
}

function correlation(x, y) {
  if (x.length !== y.length || x.length < 5) return 0;

  const mx = mean(x);
  const my = mean(y);

  const sx = std(x, mx);
  const sy = std(y, my);

  if (sx === 0 || sy === 0) return 0;

  let cov = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
  }

  cov /= x.length;

  return cov / (sx * sy);
}

/* =========================================================
   ENGINE
========================================================= */

function updateHistory(state, symbol, price) {
  state._correlationHistory =
    state._correlationHistory || {};

  state._correlationHistory[symbol] =
    state._correlationHistory[symbol] || [];

  const history = state._correlationHistory[symbol];

  history.push(price);

  if (history.length > MAX_HISTORY) {
    state._correlationHistory[symbol] =
      history.slice(-MAX_HISTORY);
  }
}

function computePortfolioCorrelation(state, symbol) {
  const historyMap = state._correlationHistory;
  if (!historyMap) return 0;

  const base = historyMap[symbol];
  if (!base || base.length < CORRELATION_LOOKBACK)
    return 0;

  const recentBase =
    base.slice(-CORRELATION_LOOKBACK);

  let highest = 0;

  for (const [sym, prices] of Object.entries(historyMap)) {
    if (sym === symbol) continue;
    if (!state.positions[sym]?.qty) continue;

    if (prices.length < CORRELATION_LOOKBACK)
      continue;

    const recent =
      prices.slice(-CORRELATION_LOOKBACK);

    const corr = Math.abs(
      correlation(recentBase, recent)
    );

    highest = Math.max(highest, corr);
  }

  return highest;
}

/* =========================================================
   EVALUATE
========================================================= */

function evaluate(state, symbol) {
  const corr = computePortfolioCorrelation(
    state,
    symbol
  );

  if (corr >= MAX_PORTFOLIO_CORRELATION) {
    return {
      allow: false,
      correlation: corr,
      riskMultiplier: CORRELATION_RISK_MULTIPLIER,
    };
  }

  return {
    allow: true,
    correlation: corr,
    riskMultiplier: clamp(
      1 - corr * 0.5,
      0.3,
      1
    ),
  };
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  updateHistory,
  evaluate,
};
