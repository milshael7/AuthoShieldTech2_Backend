// ==========================================================
// FILE: backend/src/routes/tradingAnalytics.js
// VERSION: v1.0 (Safe Trading Analytics Memory Routes)
// PURPOSE
// - Provide /api/analytics/trading endpoints expected by server.js
// - Read from app.locals.tradingAnalytics process memory
// - Expose summary, raw state, and maintenance reset
// - Stay safe if memory store is missing or partially shaped
// ==========================================================

const express = require("express");

const router = express.Router();

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function createStore() {
  return {
    tradeArchive: [],
    decisionArchive: [],
    recentResets: [],
    recentLogins: [],
  };
}

function getStore(req) {
  if (!req.app.locals.tradingAnalytics) {
    req.app.locals.tradingAnalytics = createStore();
  }

  const store = req.app.locals.tradingAnalytics;

  store.tradeArchive = ensureArray(store.tradeArchive);
  store.decisionArchive = ensureArray(store.decisionArchive);
  store.recentResets = ensureArray(store.recentResets);
  store.recentLogins = ensureArray(store.recentLogins);

  global.tradingAnalytics = store;

  return store;
}

function summarizeTrades(trades) {
  const totalTrades = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let realizedPnl = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;

  for (const trade of trades) {
    const pnl = safeNum(trade?.pnl, 0);

    realizedPnl += pnl;

    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLossAbs += Math.abs(pnl);
    } else {
      breakeven += 1;
    }
  }

  const decidedTrades = wins + losses;
  const winRate = decidedTrades > 0 ? wins / decidedTrades : 0;
  const avgPnl = totalTrades > 0 ? realizedPnl / totalTrades : 0;
  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate,
    realizedPnl,
    avgPnl,
    grossProfit,
    grossLossAbs,
    profitFactor,
  };
}

/* =========================================================
GET /api/analytics/trading
========================================================= */

router.get("/trading", (req, res) => {
  const store = getStore(req);

  const trades = ensureArray(store.tradeArchive);
  const decisions = ensureArray(store.decisionArchive);
  const recentResets = ensureArray(store.recentResets);
  const recentLogins = ensureArray(store.recentLogins);

  const summary = summarizeTrades(trades);

  return res.json({
    ok: true,
    summary: {
      ...summary,
      totalDecisions: decisions.length,
      recentResetCount: recentResets.length,
      recentLoginCount: recentLogins.length,
    },
    tradeArchive: trades.slice(-500),
    decisionArchive: decisions.slice(-500),
    recentResets: recentResets.slice(-100),
    recentLogins: recentLogins.slice(-100),
  });
});

/* =========================================================
GET /api/analytics/trading/state
========================================================= */

router.get("/trading/state", (req, res) => {
  const store = getStore(req);

  return res.json({
    ok: true,
    state: {
      tradeArchive: ensureArray(store.tradeArchive).slice(-5000),
      decisionArchive: ensureArray(store.decisionArchive).slice(-3000),
      recentResets: ensureArray(store.recentResets).slice(-1000),
      recentLogins: ensureArray(store.recentLogins).slice(-1000),
    },
  });
});

/* =========================================================
POST /api/analytics/trading/maintenance/reset
========================================================= */

router.post("/trading/maintenance/reset", (req, res) => {
  req.app.locals.tradingAnalytics = createStore();
  global.tradingAnalytics = req.app.locals.tradingAnalytics;

  return res.json({
    ok: true,
    message: "Trading analytics memory reset",
    state: req.app.locals.tradingAnalytics,
  });
});

module.exports = router;
