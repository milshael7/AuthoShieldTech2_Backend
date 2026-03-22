// ==========================================================
// 🔒 AUTOSHIELD CORE — VERIFIED BUILD
// FILE: backend/src/routes/paper.routes.js
// VERSION: v6.0 (ENGINE CORE CONNECTED — NO FAKE STATE)
//
// PURPOSE:
// - FULLY CONNECTED TO engineCore (REAL DATA)
// - REMOVES paperTrader DEPENDENCY
// - POWERS:
//   • Chart trades
//   • Positions
//   • Dashboard stats
// ==========================================================

const express = require("express");
const router = express.Router();

const engineCore = require("../engine/engineCore");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");

/* =========================================================
UTIL
========================================================= */

function getTenantId(req) {
  return req.user?.companyId || req.user?.id || null;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
STATUS
========================================================= */

router.get("/status", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId);

    return res.json({
      ok: true,
      engine: "RUNNING",
      executionStats: state.executionStats || {},
      trades: state.trades || [],
      decisions: state.decisions || [],
      time: Date.now(),
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
ACCOUNT (SIMPLIFIED LIVE STATE)
========================================================= */

router.get("/account", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId);

    const trades = state.trades || [];

    const pnl = trades.reduce((sum, t) => sum + safeNum(t.pnl), 0);

    return res.json({
      ok: true,
      account: {
        netPnL: pnl,
        totalTrades: trades.length,
      },
      time: Date.now(),
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
POSITIONS (REAL ENGINE)
========================================================= */

router.get("/positions", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId);

    return res.json({
      ok: true,
      position: state.position || null,
      positions: state.positions || {},
      time: Date.now(),
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
TRADES (🔥 THIS FIXES YOUR CHART)
========================================================= */

router.get("/orders", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId);

    const trades = state.trades || [];

    return res.json({
      ok: true,
      trades,
      orders: trades,
      count: trades.length,
      time: Date.now(),
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
DECISIONS
========================================================= */

router.get("/decisions", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId);

    return res.json({
      ok: true,
      decisions: state.decisions || [],
      count: (state.decisions || []).length,
      time: Date.now(),
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
MANUAL ORDER (CONNECTED TO ENGINE)
========================================================= */

router.post("/order", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    const { symbol, side, qty, stopLoss, takeProfit } = req.body || {};

    if (!symbol || !side) {
      return res.json({ ok: false, error: "Invalid order" });
    }

    marketEngine.registerTenant(tenantId);

    const price = marketEngine.getPrice(tenantId, symbol);

    const state = engineCore.getState(tenantId);

    const result = executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: side,
      price,
      qty,
      stopLoss,
      takeProfit,
      state,
      ts: Date.now(),
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* ========================================================= */

module.exports = router;
