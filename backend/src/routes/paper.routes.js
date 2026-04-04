// ==========================================================
// 🔒 AUTOSHIELD CORE — v7.0 (SYNCHRONIZED & PRICE-GUARDED)
// FILE: backend/src/routes/paper.routes.js
// ==========================================================

const express = require("express");
const router = express.Router();

const engineCore = require("../engine/engineCore");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");

/* ================= HELPERS ================= */
const getTenantId = (req) => req.user?.companyId || req.user?.id || null;
const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ================= READ-ONLY ENDPOINTS ================= */

router.get("/status", (req, res) => {
  const state = engineCore.getState(getTenantId(req));
  res.json({ ok: true, engine: "RUNNING", ...state, time: Date.now() });
});

router.get("/account", (req, res) => {
  const trades = engineCore.getState(getTenantId(req)).trades || [];
  const pnl = trades.reduce((sum, t) => sum + safeNum(t.pnl), 0);
  res.json({ ok: true, account: { netPnL: pnl, totalTrades: trades.length } });
});

router.get("/positions", (req, res) => {
  const state = engineCore.getState(getTenantId(req));
  res.json({ ok: true, position: state.position || null, positions: state.positions || {} });
});

// 🔥 CRITICAL FOR CHART SYNC
router.get("/orders", (req, res) => {
  const trades = engineCore.getState(getTenantId(req)).trades || [];
  res.json({ ok: true, trades, count: trades.length });
});

/* ================= MANUAL ORDER (THE BRIDGE) ================= */

router.post("/order", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { symbol, side, qty, stopLoss, takeProfit } = req.body;

    if (!symbol || !side || !qty) {
      return res.status(400).json({ ok: false, error: "Missing required order fields (symbol, side, qty)" });
    }

    // 1. Ensure Engine is Tracking this symbol
    marketEngine.registerTenant(tenantId);

    // 2. 🔥 PRICE GUARD: Don't execute if market data is missing
    const currentPrice = marketEngine.getPrice(tenantId, symbol);
    if (!currentPrice || currentPrice <= 0) {
      return res.status(422).json({ ok: false, error: `Market price for ${symbol} not available yet. Try again in 1s.` });
    }

    // 3. Dispatch to Execution Engine
    const state = engineCore.getState(tenantId);
    const result = executionEngine.executePaperOrder({
      tenantId,
      symbol,
      side: String(side).toLowerCase(), // Standardize to buy/sell
      price: currentPrice,
      qty: safeNum(qty),
      stopLoss: safeNum(stopLoss, null),
      takeProfit: safeNum(takeProfit, null),
      state,
      ts: Date.now(),
    });

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("Order Route Error:", err.message);
    return res.status(500).json({ ok: false, error: "Internal Engine Error" });
  }
});

module.exports = router;
