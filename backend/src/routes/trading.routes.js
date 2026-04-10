// ==========================================================
// 🛰️ TRADING ROUTES — v14.0 (UNIFIED STATE UPLINK)
// FILE: backend/src/routes/trading.routes.js
// ==========================================================

const express = require("express");
const router = express.Router();

// 🛡️ Middleware & Service Logic
const { authRequired, requireRole } = require("../middleware/auth");
const executionEngine = require("../services/executionEngine");
const engineCore = require("../engine/engineCore");
const stateStore = require("../engine/stateStore");

/* ================= ROLES ================= */
const ADMIN = "admin";
const MANAGER = "manager";

/* ================= HELPERS ================= */
function getTenantId(req) {
  return req.user?.companyId || req.user?.id || "default";
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 🔐 APPLY AUTH TO ALL SUBSEQUENT ROUTES
router.use(authRequired);

/* =========================================================
📊 SNAPSHOT & BRAIN STATS
========================================================= */

router.get("/ai/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    // 🛰️ PUSH 6.2: Pulling from Unified Engine Core
    const stats = engineCore.getLearningStats(tenantId);

    return res.json({
      ok: true,
      data: {
        action: stats.regime === "BULL_RUN" ? "BUY" : "WAIT",
        confidence: stats.confidence,
        regime: stats.regime,
        reason: stats.uptime + " active",
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

router.get("/performance/summary", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = stateStore.getSnapshot(tenantId);
    
    return res.json({
      ok: true,
      data: {
        totalTrades: state.trades.length,
        winRate: state.realized.wins / (state.trades.length || 1),
        netPnL: state.realized.net,
        equity: state.equity,
        cash: state.cashBalance
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
🔥 STATUS — REAL ENGINE TELEMETRY (VERCEL READY)
========================================================= */

router.get("/status", requireRole(ADMIN, MANAGER), (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = stateStore.getSnapshot(tenantId);
    const engineStats = engineCore.getLearningStats(tenantId);

    return res.json({
      ok: true,
      engine: "RUNNING",
      telemetry: {
        ticks: engineStats.trades, // Using trade count as a proxy for activity
        equity: state.equity,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      ai: {
        confidence: engineStats.confidence,
        regime: engineStats.regime,
        accuracy: engineStats.accuracy
      },
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/* =========================================================
🛒 MANUAL ORDER & EMERGENCY STOP
========================================================= */

router.post("/order", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = getTenantId(req);
  const { symbol, side, qty, stopLoss, takeProfit } = req.body || {};

  try {
    const state = stateStore.getState(tenantId);
    const price = state.lastPriceBySymbol[symbol] || 0;

    if (price <= 0) throw new Error("MARKET_DATA_OFFLINE");

    const result = executionEngine.executePaperOrder({
      tenantId,
      symbol,
      side, // 🛰️ PUSH 6.2: Unified 'side' naming
      price,
      qty: safeNum(qty, 0.1),
      stopLoss,
      takeProfit,
      state,
    });

    return res.json(result);
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// 🚨 EMERGENCY STOP ENDPOINT (Called by Frontend SecurityContext)
router.post("/emergency-stop", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = getTenantId(req);
  try {
    const state = stateStore.getState(tenantId);
    // Liquidate all positions in the execution engine
    executionEngine.executePaperOrder({
        tenantId,
        side: "CLOSE",
        price: state.lastPriceBySymbol["BTCUSDT"] || 0,
        state,
        reason: "USER_EMERGENCY_STOP"
    });
    return res.json({ ok: true, message: "TERMINAL_HALT_SUCCESSFUL" });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
