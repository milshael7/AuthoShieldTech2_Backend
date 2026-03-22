// ==========================================================
// 🔒 PROTECTED CORE FILE — MAINTENANCE SAFE
// FILE: tradingAnalytics.js
// VERSION: v2.0 (Tenant-Aware + Engine-Ready)
// ==========================================================
//
// PURPOSE:
// - Central analytics memory
// - Per-tenant tracking
// - Safe reads + writes
// - Ready for engine integration
//
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

function getTenantId(req) {
  return req.user?.companyId || req.user?.id || "__default__";
}

/* =========================================================
STORE
========================================================= */

function createStore() {
  return {
    tradeArchive: [],
    decisionArchive: [],
    recentResets: [],
    recentLogins: [],
    createdAt: Date.now(),
  };
}

function getStore(req, tenantId) {
  if (!req.app.locals.tradingAnalytics) {
    req.app.locals.tradingAnalytics = {};
  }

  if (!req.app.locals.tradingAnalytics[tenantId]) {
    req.app.locals.tradingAnalytics[tenantId] = createStore();
  }

  const store = req.app.locals.tradingAnalytics[tenantId];

  store.tradeArchive = ensureArray(store.tradeArchive);
  store.decisionArchive = ensureArray(store.decisionArchive);
  store.recentResets = ensureArray(store.recentResets);
  store.recentLogins = ensureArray(store.recentLogins);

  global.tradingAnalytics = req.app.locals.tradingAnalytics;

  return store;
}

/* =========================================================
SUMMARY ENGINE
========================================================= */

function summarizeTrades(trades) {
  const totalTrades = trades.length;

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let pnl = 0;

  for (const t of trades) {
    const p = safeNum(t?.pnl, 0);
    pnl += p;

    if (p > 0) wins++;
    else if (p < 0) losses++;
    else breakeven++;
  }

  const decided = wins + losses;

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate: decided > 0 ? wins / decided : 0,
    netPnL: pnl,
    avgPnL: totalTrades > 0 ? pnl / totalTrades : 0,
  };
}

/* =========================================================
GET SUMMARY
========================================================= */

router.get("/trading", (req, res) => {
  const tenantId = getTenantId(req);
  const store = getStore(req, tenantId);

  const trades = ensureArray(store.tradeArchive);
  const decisions = ensureArray(store.decisionArchive);

  return res.json({
    ok: true,
    summary: {
      ...summarizeTrades(trades),
      totalDecisions: decisions.length,
    },
    trades: trades.slice(-200),
    decisions: decisions.slice(-200),
  });
});

/* =========================================================
STATE (DEBUG)
========================================================= */

router.get("/trading/state", (req, res) => {
  const tenantId = getTenantId(req);
  const store = getStore(req, tenantId);

  return res.json({
    ok: true,
    state: store,
  });
});

/* =========================================================
RESET
========================================================= */

router.post("/trading/reset", (req, res) => {
  const tenantId = getTenantId(req);

  req.app.locals.tradingAnalytics[tenantId] = createStore();

  return res.json({
    ok: true,
    message: "Analytics reset",
  });
});

/* =========================================================
🔥 ENGINE HOOK (CRITICAL)
========================================================= */

// This is what your engine will call

global.pushTradeAnalytics = function (tenantId, trade) {
  try {
    if (!global.tradingAnalytics) return;

    const store =
      global.tradingAnalytics[tenantId] ||
      (global.tradingAnalytics[tenantId] = createStore());

    store.tradeArchive.push(trade);

    if (store.tradeArchive.length > 2000) {
      store.tradeArchive.shift();
    }

  } catch {}
};

global.pushDecisionAnalytics = function (tenantId, decision) {
  try {
    if (!global.tradingAnalytics) return;

    const store =
      global.tradingAnalytics[tenantId] ||
      (global.tradingAnalytics[tenantId] = createStore());

    store.decisionArchive.push(decision);

    if (store.decisionArchive.length > 2000) {
      store.decisionArchive.shift();
    }

  } catch {}
};

module.exports = router;
