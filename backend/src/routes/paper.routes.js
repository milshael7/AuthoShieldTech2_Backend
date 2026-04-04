// ==========================================================
// 🛡️ STEALTH ROUTES — v13.0 (FINAL SYNC & COMPANY-ID GUARD)
// Replacement for: backend/src/routes/paper.routes.js
// ==========================================================

const express = require("express");
const router = express.Router();

// SYNCED TO NEW STEALTH TRILOGY
const stealthCore = require("../services/paperTrader"); // v53 Core
const marketEngine = require("../services/marketEngine"); // v9.0 Heart

/* ================= HELPERS (PRESERVED FROM v7.0) ================= */
const getTenantId = (req) => req.user?.companyId || req.user?.id || "default_user";
const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ================= READ-ONLY ENDPOINTS ================= */

// Updated to show the "Stealth Learning" Status
router.get("/status", (req, res) => {
  const state = stealthCore.snapshot(getTenantId(req));
  res.json({ 
    ok: true, 
    engine: "STEALTH_LEARNING", 
    confidence: global.lastConfidence || 0,
    ...state, 
    time: Date.now() 
  });
});

router.get("/account", (req, res) => {
  const state = stealthCore.snapshot(getTenantId(req));
  res.json({ 
    ok: true, 
    account: { 
      equity: state.equity,
      balance: state.balance,
      totalTrades: state.history.length 
    } 
  });
});

router.get("/positions", (req, res) => {
  const state = stealthCore.snapshot(getTenantId(req));
  res.json({ ok: true, position: state.position || null });
});

router.get("/orders", (req, res) => {
  const state = stealthCore.snapshot(getTenantId(req));
  res.json({ ok: true, trades: state.history, intelligence: state.intelligence });
});

/* ================= MANUAL ORDER (STEALTH ADAPTED) ================= */

router.post("/order", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { symbol, side, qty } = req.body;

    if (!symbol || !side) {
      return res.status(400).json({ ok: false, error: "Missing symbol or side" });
    }

    // 1. Ensure Engine Heart is beating
    marketEngine.registerTenant(tenantId);

    // 2. 🔥 PRICE GUARD (v7.0 Logic Preserved)
    const currentPrice = marketEngine.getPrice(tenantId, symbol);
    if (!currentPrice || currentPrice <= 0) {
      return res.status(422).json({ ok: false, error: `Market price for ${symbol} warming up...` });
    }

    // 3. EXECUTE VIA STEALTH CORE (The AI doesn't know you clicked it!)
    // We treat manual orders as high-confidence AI orders to keep the data clean
    stealthCore.tick(tenantId, symbol, currentPrice); 

    return res.json({ ok: true, message: "Stealth Order Processed", price: currentPrice });
  } catch (err) {
    console.error("Stealth Order Route Error:", err.message);
    return res.status(500).json({ ok: false, error: "Internal Stealth Error" });
  }
});

module.exports = router;
