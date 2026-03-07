// backend/src/routes/market.routes.js
// ==========================================================
// Market Data API — STABLE VERSION
// Single-auth • Tenant-safe • WS-consistent
// ==========================================================

const express = require("express");
const router = express.Router();

const marketEngine = require("../services/marketEngine");

/* =========================================================
   TENANT RESOLUTION
========================================================= */

function resolveTenant(req) {
  return req.user?.companyId || req.user?.id || null;
}

function normalizeSymbol(v) {
  return String(v || "BTCUSDT").trim().toUpperCase();
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/* =========================================================
   GET MARKET PRICE
   GET /api/market/price?symbol=BTCUSDT
========================================================= */

router.get("/price", (req, res) => {
  try {

    const tenantId = resolveTenant(req);
    if (!tenantId)
      return res.status(400).json({ ok:false,error:"Missing tenant" });

    const symbol = normalizeSymbol(req.query.symbol);

    const price =
      marketEngine.getPrice(tenantId, symbol);

    return res.json({
      ok:true,
      symbol,
      price: price ?? null,
      ts: Date.now()
    });

  } catch {

    return res.status(500).json({
      ok:false,
      error:"Market price unavailable"
    });

  }
});

/* =========================================================
   GET MARKET CANDLES
   GET /api/market/candles?symbol=BTCUSDT&limit=200
========================================================= */

router.get("/candles", (req,res)=>{

  try{

    const tenantId = resolveTenant(req);
    if(!tenantId)
      return res.status(400).json({ok:false,error:"Missing tenant"});

    const symbol = normalizeSymbol(req.query.symbol);
    const limit = clamp(req.query.limit,20,500);

    const candles =
      marketEngine.getCandles(tenantId,symbol,limit) || [];

    return res.json({
      ok:true,
      symbol,
      candles,
      count:candles.length,
      ts:Date.now()
    });

  }catch{

    return res.status(500).json({
      ok:false,
      error:"Market candles unavailable"
    });

  }

});

/* =========================================================
   MARKET SNAPSHOT (NEW)
   GET /api/market/snapshot?symbol=BTCUSDT
========================================================= */

router.get("/snapshot",(req,res)=>{

  try{

    const tenantId = resolveTenant(req);
    if(!tenantId)
      return res.status(400).json({ok:false,error:"Missing tenant"});

    const symbol = normalizeSymbol(req.query.symbol);

    const price =
      marketEngine.getPrice(tenantId,symbol);

    const candles =
      marketEngine.getCandles(tenantId,symbol,200) || [];

    return res.json({

      ok:true,
      symbol,
      price,
      candles,
      count:candles.length,
      ts:Date.now()

    });

  }catch{

    return res.status(500).json({
      ok:false,
      error:"Market snapshot unavailable"
    });

  }

});

module.exports = router;
