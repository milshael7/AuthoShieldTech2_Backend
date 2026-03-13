// ==========================================================
// Institutional Trading Control API — STABLE ENTERPRISE v8
// FIXED: AI visibility + learning stats + telemetry
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");

const paperTrader = require("../services/paperTrader");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");

const aiBrain = require("../../brain/aiBrain");
const memoryBrain = require("../../brain/memoryBrain");

const { readDb, writeDb } = require("../lib/db");

/* ================= ROLES ================= */

const ADMIN = "Admin";
const MANAGER = "Manager";

/* =========================================================
TENANT SAFE ACCESS
========================================================= */

function getTenantId(req){

  return (
    req.tenant?.id ||
    req.user?.companyId ||
    req.user?.id ||
    null
  );

}

/* =========================================================
AI CONFIG
========================================================= */

function getAIConfig(tenantId){

  const db = readDb();

  db.tradingConfig = db.tradingConfig || {};

  if(!db.tradingConfig[tenantId]){

    db.tradingConfig[tenantId] = {
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
      riskPercent:1.5,
      positionMultiplier:1,
      strategyMode:"Balanced"
    };

    writeDb(db);

  }

  return db.tradingConfig[tenantId];

}

/* =========================================================
AUTH
========================================================= */

router.use(authRequired);

/* =========================================================
CONTROL ROOM SNAPSHOT
========================================================= */

router.get("/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  marketEngine.registerTenant(tenantId);

  const snapshot =
    paperTrader.snapshot(tenantId) || {};

  return res.json({
    ok:true,
    snapshot
  });

});

/* =========================================================
AI DECISIONS
========================================================= */

router.get("/decisions",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  const decisions =
    paperTrader.getDecisions(tenantId) || [];

  return res.json({
    ok:true,
    decisions
  });

});

/* =========================================================
CURRENT PRICE
========================================================= */

router.get("/price",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  marketEngine.registerTenant(tenantId);

  const price =
    marketEngine.getPrice(tenantId,"BTCUSDT");

  return res.json({
    ok:true,
    price: Number(price || 0)
  });

});

/* =========================================================
MANUAL PAPER ORDER
========================================================= */

router.post("/order",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  const {
    symbol,
    side,
    price,
    risk
  } = req.body || {};

  try{

    marketEngine.registerTenant(tenantId);

    const state =
      paperTrader.snapshot(tenantId);

    const result =
      executionEngine.executePaperOrder({

        tenantId,
        symbol:String(symbol).toUpperCase(),
        action:String(side).toUpperCase(),
        price:Number(price),
        riskPct:Number(risk || 0.01),
        state,
        ts:Date.now()

      });

    return res.json({
      ok:true,
      result
    });

  }
  catch(err){

    return res.json({
      ok:false,
      error:String(err.message)
    });

  }

});

/* =========================================================
ENGINE HEALTH
========================================================= */

function getEngineHealth(tenantId){

  try{

    const snap =
      paperTrader.snapshot(tenantId);

    const ticks =
      snap?.executionStats?.ticks || 0;

    const decisions =
      snap?.executionStats?.decisions || 0;

    if(ticks > 0 || decisions > 0)
      return "RUNNING";

    return "STARTING";

  }
  catch{

    return "UNKNOWN";

  }

}

/* =========================================================
ENGINE TELEMETRY
========================================================= */

function getTelemetry(tenantId){

  try{

    const snap =
      paperTrader.snapshot(tenantId);

    const stats =
      snap?.executionStats || {};

    return {

      ticks: stats.ticks || 0,
      decisions: stats.decisions || 0,
      trades: stats.trades || 0,

      memoryMb:
        Math.round(
          process.memoryUsage().rss / 1024 / 1024
        )

    };

  }
  catch{

    return {
      ticks:0,
      decisions:0,
      trades:0,
      memoryMb:0
    };

  }

}

/* =========================================================
AI BRAIN SNAPSHOT (OUTSIDE BRAIN)
========================================================= */

router.get("/brain",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  try{

    const brain =
      aiBrain.getSnapshot(tenantId);

    return res.json({
      ok:true,
      brain
    });

  }
  catch(err){

    return res.json({
      ok:false,
      error:String(err.message)
    });

  }

});

/* =========================================================
LEARNING MEMORY
========================================================= */

router.get("/learning",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  try{

    const mem =
      memoryBrain.snapshot(tenantId);

    return res.json({
      ok:true,
      memory:mem
    });

  }
  catch(err){

    return res.json({
      ok:false,
      error:String(err.message)
    });

  }

});

/* =========================================================
AI STATUS
========================================================= */

router.get("/status",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  const engine =
    getEngineHealth(tenantId);

  const telemetry =
    getTelemetry(tenantId);

  return res.json({
    ok:true,
    engine,
    telemetry
  });

});

/* =========================================================
AI CONFIG
========================================================= */

router.get("/config",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  const config =
    getAIConfig(tenantId);

  const engine =
    getEngineHealth(tenantId);

  const telemetry =
    getTelemetry(tenantId);

  return res.json({
    ok:true,
    config,
    engine,
    telemetry
  });

});

router.post("/config",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  const db = readDb();
  db.tradingConfig = db.tradingConfig || {};

  const cfg = getAIConfig(tenantId);

  const {
    enabled,
    tradingMode,
    maxTrades,
    riskPercent,
    positionMultiplier,
    strategyMode
  } = req.body || {};

  cfg.enabled = Boolean(enabled);
  cfg.tradingMode = tradingMode || "paper";
  cfg.maxTrades = Number(maxTrades || 5);
  cfg.riskPercent = Number(riskPercent || 1.5);
  cfg.positionMultiplier = Number(positionMultiplier || 1);
  cfg.strategyMode = strategyMode || "Balanced";

  db.tradingConfig[tenantId] = cfg;

  writeDb(db);

  const engine =
    getEngineHealth(tenantId);

  const telemetry =
    getTelemetry(tenantId);

  return res.json({
    ok:true,
    config:cfg,
    engine,
    telemetry
  });

});

/* ========================================================= */

module.exports = router;
