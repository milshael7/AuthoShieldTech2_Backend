// ==========================================================
// FILE: backend/src/routes/paper.routes.js
// Paper Engine API — FULL INSTITUTIONAL STATE EXPOSURE v3
//
// SAFETY UPDATES
// - Fixed manual order routing
// - Manual orders now pass through executionEngine
// - Prevents bypassing risk limits
// - Hardened tenant validation
// ==========================================================

const express = require("express");
const router = express.Router();

const paperTrader = require("../services/paperTrader");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");
const { readDb } = require("../lib/db");

/* =========================================================
   TENANT RESOLUTION
========================================================= */

function resolveTenant(req){
  return req.user?.companyId || req.user?.id || null;
}

/* =========================================================
   STATUS
========================================================= */

router.get("/status",(req,res)=>{

  try{

    const tenantId = resolveTenant(req);

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant context"
      });
    }

    const snapshot = paperTrader.snapshot(tenantId);

    if(!snapshot){
      return res.json({
        ok:true,
        engine:"IDLE",
        snapshot:null
      });
    }

    const db = readDb();

    const rawConfig = db.tradingConfig || {};
    const tradingConfig =
      rawConfig[tenantId] || rawConfig || {};

    const decisions =
      paperTrader.getDecisions?.(tenantId) || [];

    const lastDecision =
      decisions.length
        ? decisions[decisions.length-1]
        : null;

    const engineState = {

      mode:
        tradingConfig.tradingMode || "paper",

      enabled:
        tradingConfig.enabled ?? true,

      riskPercent:
        tradingConfig.riskPercent ?? 1.5,

      maxTrades:
        tradingConfig.maxTrades ?? 5,

      positionMultiplier:
        tradingConfig.positionMultiplier ?? 1,

      strategyMode:
        tradingConfig.strategyMode || "Balanced"

    };

    const brainState = {

      lastAction:
        lastDecision?.action || "WAIT",

      smoothedConfidence:
        Number(lastDecision?.confidence || 0),

      edgeMomentum:
        Number(lastDecision?.edge || 0),

      winStreak:
        snapshot.realized?.wins || 0,

      lossStreak:
        snapshot.realized?.losses || 0

    };

    return res.json({

      ok:true,

      engine:
        snapshot.executionStats?.ticks > 0
          ? "RUNNING"
          : "IDLE",

      engineState,
      brainState,

      executionStats:
        snapshot.executionStats || {},

      snapshot,

      time:new Date().toISOString()

    });

  }
  catch{

    return res.status(500).json({
      ok:false,
      error:"Paper engine unavailable"
    });

  }

});

/* =========================================================
   DECISIONS
========================================================= */

router.get("/decisions",(req,res)=>{

  try{

    const tenantId = resolveTenant(req);

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant context"
      });
    }

    const decisions =
      paperTrader.getDecisions?.(tenantId) || [];

    return res.json({
      ok:true,
      decisions,
      count:decisions.length,
      time:new Date().toISOString()
    });

  }
  catch{

    return res.status(500).json({
      ok:false,
      error:"Decision stream unavailable"
    });

  }

});

/* =========================================================
   RESET
========================================================= */

router.post("/reset",(req,res)=>{

  try{

    const tenantId = resolveTenant(req);

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant context"
      });
    }

    paperTrader.hardReset(tenantId);

    return res.json({

      ok:true,
      snapshot:paperTrader.snapshot(tenantId),
      time:new Date().toISOString()

    });

  }
  catch{

    return res.status(500).json({
      ok:false,
      error:"Paper reset failed"
    });

  }

});

/* =========================================================
   MANUAL ORDER (SAFE ROUTING)
========================================================= */

router.post("/order",(req,res)=>{

  try{

    const tenantId = resolveTenant(req);

    if(!tenantId){
      return res.status(400).json({
        ok:false,
        error:"Missing tenant context"
      });
    }

    const {
      symbol,
      side,
      size,
      price
    } = req.body || {};

    if(!symbol || !side){
      return res.status(400).json({
        ok:false,
        error:"Invalid order payload"
      });
    }

    const marketPrice =
      marketEngine.getPrice(tenantId,symbol)
      || Number(price)
      || 0;

    if(!marketPrice || !Number.isFinite(marketPrice)){
      return res.status(400).json({
        ok:false,
        error:"Market price unavailable"
      });
    }

    const state =
      paperTrader.snapshot(tenantId);

    const result =
      executionEngine.executePaperOrder({

        tenantId,
        symbol,
        action:side,
        price:marketPrice,
        qty:Number(size || 0),
        state,
        ts:Date.now()

      });

    return res.json({

      ok:true,
      result,
      snapshot:paperTrader.snapshot(tenantId),
      time:new Date().toISOString()

    });

  }
  catch(err){

    return res.status(500).json({
      ok:false,
      error:err?.message || "Paper order failed"
    });

  }

});

module.exports = router;
