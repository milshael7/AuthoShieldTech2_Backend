// ==========================================================
// Institutional Trading Control API — STABLE ENTERPRISE v5
// FIXED: /api/ai/config route alignment + engine health detection
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");

const paperTrader = require("../services/paperTrader");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");

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
AI CONFIG (ENGINE CONNECTED)
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
PUBLIC SYMBOLS
========================================================= */

router.get("/symbols",(req,res)=>{

  return res.json({
    ok:true,
    symbols:["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"]
  });

});

/* =========================================================
AUTH
========================================================= */

router.use(authRequired);

/* =========================================================
MARKET
========================================================= */

router.get("/market/price/:symbol",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);
  const symbol = String(req.params.symbol || "").toUpperCase();

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  marketEngine.registerTenant(tenantId);

  const price =
    marketEngine.getPrice(tenantId,symbol);

  return res.json({
    ok:true,
    tenantId,
    symbol,
    price
  });

});

router.get("/market/candles/:symbol",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);
  const symbol = String(req.params.symbol || "").toUpperCase();
  const limit = Number(req.query.limit || 200);

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  marketEngine.registerTenant(tenantId);

  const candles =
    marketEngine.getCandles(
      tenantId,
      symbol,
      limit
    );

  return res.json({
    ok:true,
    tenantId,
    symbol,
    candles
  });

});

/* =========================================================
MANUAL PAPER ORDER
========================================================= */

router.post("/paper/order",
requireRole(ADMIN,MANAGER),
async (req,res)=>{

  const tenantId = getTenantId(req);

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const { symbol, side, price, risk } = req.body || {};

  if(!symbol || !side)
    return res.status(400).json({
      ok:false,
      error:"Invalid order request"
    });

  try{

    marketEngine.registerTenant(tenantId);

    const state =
      paperTrader.snapshot(tenantId);

    const result =
      executionEngine.executePaperOrder({

        tenantId,
        symbol:String(symbol).toUpperCase(),
        action:side.toUpperCase(),
        price:Number(price),
        riskPct:Number(risk || 0.01),
        state,
        ts:Date.now()

      });

    if(!result){

      return res.json({
        ok:false,
        error:"Order rejected"
      });

    }

    return res.json({
      ok:true,
      result
    });

  }
  catch(err){

    return res.json({
      ok:false,
      error:String(err?.message || err)
    });

  }

});

/* =========================================================
PAPER SNAPSHOT
========================================================= */

router.get("/paper/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  marketEngine.registerTenant(tenantId);

  const snapshot =
    paperTrader.snapshot(tenantId);

  return res.json({
    ok:true,
    tenantId,
    snapshot
  });

});

/* =========================================================
ENGINE HEALTH DETECTOR
========================================================= */

function getEngineHealth(tenantId){

  try{

    const snap =
      paperTrader.snapshot(tenantId);

    const ticks =
      snap?.executionStats?.ticks || 0;

    if(ticks > 0)
      return "RUNNING";

    return "STARTING";

  }catch{

    return "UNKNOWN";

  }

}

/* =========================================================
AI CONFIG
FINAL ROUTE → /api/ai/config
========================================================= */

router.get("/config",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = getTenantId(req);

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const config = getAIConfig(tenantId);
  const engine = getEngineHealth(tenantId);

  return res.json({
    ok:true,
    config,
    engine
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

  const engine = getEngineHealth(tenantId);

  return res.json({
    ok:true,
    config:cfg,
    engine
  });

});

module.exports = router;
