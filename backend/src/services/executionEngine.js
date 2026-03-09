// ==========================================================
// Institutional Trading Control API — FINAL
// Dashboard + Market + Paper + Live + Risk + AI
// Tenant Safe • Role Protected • Snapshot Accurate
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { audit } = require("../lib/audit");

const paperTrader = require("../services/paperTrader");
const liveTrader = require("../services/liveTrader");
const riskManager = require("../services/riskManager");
const portfolioManager = require("../services/portfolioManager");
const aiBrain = require("../services/aiBrain");
const executionEngine = require("../services/executionEngine");
const exchangeRouter = require("../services/exchangeRouter");
const marketEngine = require("../services/marketEngine");

// ---------------- ROLES ----------------

const ADMIN = "Admin";
const MANAGER = "Manager";

/* =========================================================
AI CONFIG STORAGE
========================================================= */

const AI_CONFIG = new Map();

function getAIConfig(tenantId){

  if(!AI_CONFIG.has(tenantId)){

    AI_CONFIG.set(tenantId,{
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
      riskPercent:1.5,
      positionMultiplier:1,
      strategyMode:"Balanced"
    });

  }

  return AI_CONFIG.get(tenantId);

}

/* =========================================================
PUBLIC
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

  const tenantId = req.tenant?.id;
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

  const tenantId = req.tenant?.id;
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
MANUAL ORDER ROUTE  (THIS IS THE IMPORTANT PART)
========================================================= */

router.post("/paper/order",
requireRole(ADMIN,MANAGER),
async (req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const {
    symbol,
    side,
    type,
    qty,
    price,
    risk
  } = req.body || {};

  if(!symbol || !side)
    return res.status(400).json({
      ok:false,
      error:"Invalid order request"
    });

  try{

    const state =
      paperTrader.snapshot(tenantId);

    const result =
      await executionEngine.executeOrder({

        tenantId,
        symbol:String(symbol).toUpperCase(),
        action:side.toUpperCase(),
        price:Number(price),
        riskPct:Number(risk || 0.01),
        state

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

  const tenantId = req.tenant?.id;

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
AI CONFIG
========================================================= */

router.get("/ai/config",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  const config = getAIConfig(tenantId);

  return res.json({
    ok:true,
    config,
    engine:"RUNNING"
  });

});

router.post("/ai/config",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

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

  return res.json({
    ok:true,
    config:cfg
  });

});

/* ========================================================= */

module.exports = router;
