// backend/src/routes/paper.market.routes.js
// Paper Market Data API
// Chart Data + Price Feed

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const paperTrader = require("../services/paperTrader");

router.use(authRequired);

/* =========================================================
   TENANT HELPER
========================================================= */

function tenant(req){
  return req.tenant?.id || null;
}

/* =========================================================
   GET MARKET PRICE
   GET /api/paper/price
========================================================= */

router.get("/price",(req,res)=>{

  try{

    const tenantId = tenant(req)

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant"
      })
    }

    const price = paperTrader.getMarketPrice(tenantId)

    res.json({
      ok:true,
      price
    })

  }catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    })

  }

})

/* =========================================================
   GET CANDLES
   GET /api/paper/candles
========================================================= */

router.get("/candles",(req,res)=>{

  try{

    const tenantId = tenant(req)

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant"
      })
    }

    const limit = Number(req.query.limit || 200)

    const candles = paperTrader.getCandles(tenantId,limit)

    res.json({
      ok:true,
      candles
    })

  }catch(e){

    res.status(500).json({
      ok:false,
      error:e.message
    })

  }

})

module.exports = router;
