// backend/src/services/metricsEngine.js
// Phase 8 — Institutional Metrics Engine
// Computes performance analytics for Paper + Live engines
// Tenant Safe • Strategy Agnostic • Zero External Dependencies

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
   HELPERS
========================================================= */

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const variance =
    arr.reduce((a, b) => a + Math.pow(b - avg, 2), 0) /
    (arr.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdownFromEquity(equityCurve = []) {
  let peak = -Infinity;
  let maxDD = 0;

  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD;
}

/* =========================================================
   CORE METRICS
========================================================= */

function computeMetrics({
  trades = [],
  equityCurve = [],
  riskFreeRate = 0,
}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return emptyMetrics();
  }

  const profits = trades.map(t => safeNum(t.profit, 0));
  const wins = profits.filter(p => p > 0);
  const losses = profits.filter(p => p <= 0);

  const total = profits.length;

  const winRate = wins.length / total;
  const lossRate = losses.length / total;

  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;

  const expectancy =
    winRate * avgWin + lossRate * avgLoss;

  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const profitFactor =
    grossLoss === 0 ? Infinity : grossProfit / grossLoss;

  /* ---------------- Returns for Risk Metrics ---------------- */

  const returns = equityCurve.length > 1
    ? equityCurve
        .slice(1)
        .map((eq, i) =>
          equityCurve[i] > 0
            ? (eq - equityCurve[i]) / equityCurve[i]
            : 0
        )
    : [];

  const avgReturn = mean(returns);
  const returnStd = stdDev(returns);

  const sharpe =
    returnStd === 0
      ? 0
      : (avgReturn - riskFreeRate) / returnStd;

  const downside = returns.filter(r => r < 0);
  const downsideStd = stdDev(downside);

  const sortino =
    downsideStd === 0
      ? 0
      : (avgReturn - riskFreeRate) / downsideStd;

  const maxDrawdown = maxDrawdownFromEquity(equityCurve);

  const exposurePct =
    trades.length && equityCurve.length
      ? clamp(trades.length / equityCurve.length, 0, 1)
      : 0;

  return {
    totalTrades: total,
    winRate,
    lossRate,
    expectancy,
    avgWin,
    avgLoss,
    profitFactor,
    sharpe,
    sortino,
    maxDrawdown,
    exposurePct,
    grossProfit,
    grossLoss,
  };
}

/* =========================================================
   EMPTY METRICS
========================================================= */

function emptyMetrics() {
  return {
    totalTrades: 0,
    winRate: 0,
    lossRate: 0,
    expectancy: 0,
    avgWin: 0,
    avgLoss: 0,
    profitFactor: 0,
    sharpe: 0,
    sortino: 0,
    maxDrawdown: 0,
    exposurePct: 0,
    grossProfit: 0,
    grossLoss: 0,
  };
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  computeMetrics,
};
