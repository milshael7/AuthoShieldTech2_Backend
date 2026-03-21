// ==========================================================
// FILE: backend/src/routes/trading.routes.js
// FIXED: FULL ENGINE + AI + ANALYTICS BRIDGE (v10)
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");

const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");
const engineCore = require("../engine/engineCore");

const { readDb, writeDb } = require("../lib/db");

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
🔥 AI SNAPSHOT (FIXED)
========================================================= */

router.get(
  "/ai/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
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
  }
);

/* =========================================================
🔥 AI BRAIN STATS (FIXED)
========================================================= */

router.get(
  "/ai/brain/stats",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
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
  }
);

/* =========================================================
🔥 PERFORMANCE SUMMARY (FIXED)
========================================================= */

router.get(
  "/performance/summary",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
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
  }
);

/* =========================================================
PRICE
========================================================= */

router.get(
  "/price",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    marketEngine.registerTenant(tenantId);

    const price = marketEngine.getPrice(tenantId, "BTCUSDT");

    return res.json({
      ok: true,
      price: Number(price || 0),
    });
  }
);

/* =========================================================
MANUAL ORDER (CONNECTED TO ENGINE)
========================================================= */

router.post(
  "/order",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    const { symbol, side, qty, stopLoss, takeProfit } = req.body || {};

    try {
      marketEngine.registerTenant(tenantId);

      const price =
        marketEngine.getPrice(tenantId, symbol) || 0;

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
  }
);

/* ========================================================= */

module.exports = router;
