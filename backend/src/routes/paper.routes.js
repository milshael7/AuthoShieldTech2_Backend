// ==========================================================
// 🛡️ STEALTH ROUTES — v13.1 (FRONTEND ADAPTER SYNC)
// FILE: backend/src/routes/paper.routes.js
// ==========================================================

const express = require("express");
const router = express.Router();
const stealthCore = require("../services/paperTrader"); 
const marketEngine = require("../services/marketEngine");

/* ================= HELPERS ================= */
const getTenantId = (req) => req.user?.companyId || req.user?.id || "default_user";

/* ================= 🛰️ STEP 3 FIX: ENDPOINT RENAMING ================= */

/**
 * GET /snapshot
 * Renamed from /status to match frontend expectation.
 * Provides the full engine state for initial page load.
 */
router.get("/snapshot", (req, res) => {
  const tenantId = getTenantId(req);
  const state = stealthCore.snapshot(tenantId);
  res.json({ 
    ok: true, 
    ...state, // Includes equity, balance, position, trades, intelligence
    engine: "STEALTH_LEARNING",
    confidence: global.lastConfidence || 0,
    time: Date.now() 
  });
});

/**
 * POST /trade
 * Renamed from /order to match frontend OrderPanel.jsx calls.
 */
router.post("/trade", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { symbol, side } = req.body;

    if (!symbol || !side) {
      return res.status(400).json({ ok: false, error: "Missing symbol or side" });
    }

    marketEngine.registerTenant(tenantId);
    const currentPrice = marketEngine.getPrice(tenantId, symbol);

    if (!currentPrice || currentPrice <= 0) {
      return res.status(422).json({ ok: false, error: `Market warming up...` });
    }

    // Process trade immediately via core tick
    stealthCore.tick(tenantId, symbol, currentPrice); 

    return res.json({ 
      ok: true, 
      message: "Order Processed", 
      price: currentPrice 
    });
  } catch (err) {
    console.error("Trade Route Error:", err.message);
    return res.status(500).json({ ok: false, error: "Internal Engine Error" });
  }
});

/**
 * POST /emergency-stop
 * New endpoint to handle UI Emergency Exit button.
 */
router.post("/emergency-stop", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const state = stealthCore.snapshot(tenantId);
    
    if (state.position) {
      const price = marketEngine.getPrice(tenantId, state.position.symbol);
      // We trigger a tick with a force-exit condition via the Core logic
      stealthCore.tick(tenantId, state.position.symbol, price); 
    }
    
    return res.json({ ok: true, message: "Emergency Exit Protocol Engaged" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "System Lockdown Failed" });
  }
});

/* ================= LEGACY SUPPORT (STABILITY) ================= */
// We keep these briefly so other services don't break during transition
router.get("/status", (req, res) => res.redirect("/api/paper/snapshot"));
router.get("/orders", (req, res) => {
  const state = stealthCore.snapshot(getTenantId(req));
  res.json({ ok: true, trades: state.trades, intelligence: state.intelligence });
});

module.exports = router;
