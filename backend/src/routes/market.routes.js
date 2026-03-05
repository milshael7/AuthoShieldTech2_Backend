// backend/src/routes/market.routes.js
// ==========================================================
// Market Data API
// Provides candles + price from marketEngine
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const marketEngine = require("../services/marketEngine");

/* ================= AUTH ================= */

router.use(authRequired);

/* ================= HELPERS ================= */

function getTenant(req){
  return req.tenant?.id || req.user?.companyId || req.user?.id || null;
}

/* =========================================================
   GET MARKET PRICE
   GET /api/market/price?symbol=BTCUSDT
========================================================= */

router.get("/price",(req,res)=>{

  try{

    const tenantId = getTenant(req);
    const symbol = String(req.query.symbol || "BTCUSDT");

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant"
      });
    }

    const price = marketEngine.getPrice(tenantId,symbol);

    res.json({
      ok:true,
      symbol,
      price
    });

  }catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

/* =========================================================
   GET MARKET CANDLES
   GET /api/market/candles?symbol=BTCUSDT&limit=200
========================================================= */

router.get("/candles",(req,res)=>{

  try{

    const tenantId = getTenant(req);
    const symbol = String(req.query.symbol || "BTCUSDT");
    const limit = Number(req.query.limit || 200);

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant"
      });
    }

    const candles = marketEngine.getCandles(tenantId,symbol,limit);

    res.json({
      ok:true,
      symbol,
      candles
    });

  }catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

module.exports = router;
