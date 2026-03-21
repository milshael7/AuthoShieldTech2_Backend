// ==========================================================
// FILE: backend/src/routes/trading.routes.js
// VERSION: v12 (REAL ENGINE TELEMETRY + AI FIXED)
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");

const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");
const engineCore = require("../engine/engineCore");

/* ================= ROLES ================= */

const ADMIN = "Admin";
const MANAGER = "Manager";

/* =========================================================
UTIL
========================================================= */

function getTenantId(req) {
  return req.tenant?.id || req.user?.companyId || req.user?.id || null;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
AUTH
========================================================= */

router.use(authRequired);

/* =========================================================
AI SNAPSHOT
========================================================= */

router.get("/ai/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId) || {};

    const trades = state.trades || [];
    const last = trades[trades.length - 1];

    return res.json({
      ok: true,
      data: {
        action: last?.side || "WAIT",
        confidence: last?.confidence || 0.5,
        edge: 0,
        regime: "live",
        reason: "engine_live",
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
AI BRAIN STATS
========================================================= */

router.get("/ai/brain/stats", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId) || {};
    const trades = state.trades || [];

    const totalTrades = trades.length;
    let wins = 0;
    let pnl = 0;

    for (const t of trades) {
      if (t.pnl > 0) wins++;
      pnl += safeNum(t.pnl);
    }

    return res.json({
      ok: true,
      data: {
        totalTrades,
        winRate: totalTrades > 0 ? wins / totalTrades : 0,
        netPnL: pnl,
        memoryDepth: trades.length,
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
PERFORMANCE
========================================================= */

router.get("/performance/summary", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = engineCore.getState(tenantId) || {};
    const trades = state.trades || [];

    const totalTrades = trades.length;

    let wins = 0;
    let pnl = 0;

    for (const t of trades) {
      if (t.pnl > 0) wins++;
      pnl += safeNum(t.pnl);
    }

    return res.json({
      ok: true,
      data: {
        totalTrades,
        winRate: totalTrades > 0 ? wins / totalTrades : 0,
        netPnL: pnl,
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
🔥 STATUS — FULLY FIXED
========================================================= */

router.get("/status", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);

    const state = engineCore.getState(tenantId) || {};
    const trades = state.trades || [];
    const decisions = state.decisions || [];

    /* ================= ENGINE ================= */

    const engine =
      trades.length > 0 || decisions.length > 0
        ? "RUNNING"
        : "STARTING";

    /* ================= AI RATE ================= */

    const now = Date.now();
    const lastMinute = now - 60000;

    const recentDecisions = decisions.filter(
      (d) => d.time > lastMinute
    ).length;

    /* ================= CONFIDENCE ================= */

    const avgConfidence =
      decisions.length > 0
        ? decisions.reduce(
            (sum, d) => sum + safeNum(d.confidence),
            0
          ) / decisions.length
        : 0;

    /* ================= VOLATILITY ================= */

    let volatility = 0;

    if (trades.length > 5) {
      const pnls = trades.map((t) => safeNum(t.pnl));

      const avg =
        pnls.reduce((a, b) => a + b, 0) / pnls.length;

      const variance =
        pnls.reduce(
          (sum, p) => sum + Math.pow(p - avg, 2),
          0
        ) / pnls.length;

      volatility = Math.sqrt(variance);
    }

    return res.json({
      ok: true,
      engine,

      telemetry: {
        ticks: decisions.length,
        decisions: decisions.length,
        trades: trades.length,
        memoryMb: Math.round(
          process.memoryUsage().rss / 1024 / 1024
        ),
      },

      ai: {
        rate: recentDecisions,
        confidence: avgConfidence,
        volatility,
      },
    });
  } catch (err) {
    return res.json({
      ok: false,
      error: err.message,
    });
  }
});

/* =========================================================
PRICE
========================================================= */

router.get("/price", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = getTenantId(req);

  marketEngine.registerTenant(tenantId);

  const price = marketEngine.getPrice(tenantId, "BTCUSDT");

  return res.json({
    ok: true,
    price: Number(price || 0),
  });
});

/* =========================================================
MANUAL ORDER
========================================================= */

router.post("/order", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = getTenantId(req);

  const { symbol, side, qty, stopLoss, takeProfit } = req.body || {};

  try {
    marketEngine.registerTenant(tenantId);

    const price = marketEngine.getPrice(tenantId, symbol) || 0;

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
    return res.json({
      ok: false,
      error: err.message,
    });
  }
});

/* ========================================================= */

module.exports = router;
