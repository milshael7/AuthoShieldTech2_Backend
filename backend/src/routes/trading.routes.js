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
const exchangeRouter = require("../services/exchangeRouter");
const marketEngine = require("../services/marketEngine");

// ---------------- ROLES ----------------

const ADMIN = "Admin";
const MANAGER = "Manager";

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
DASHBOARD SUPPORT
========================================================= */

router.get("/price",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const price =
    paperTrader.getMarketPrice?.(tenantId);

  return res.json({
    ok:true,
    price
  });

});

router.get("/decisions",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const decisions =
    paperTrader.getDecisions?.(tenantId) || [];

  return res.json(decisions);

});

/* =========================================================
PAPER
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

router.post("/paper/reset",
requireRole(ADMIN),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  paperTrader.hardReset(tenantId);

  audit({
    actorId:req.user.id,
    action:"PAPER_TRADING_RESET",
    targetType:"TradingState",
    targetId:"paper",
    companyId:tenantId
  });

  return res.json({ok:true});

});

/* =========================================================
LIVE
========================================================= */

router.get("/live/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const snapshot =
    liveTrader.snapshot(tenantId);

  return res.json({
    ok:true,
    tenantId,
    snapshot
  });

});

/* =========================================================
RISK
========================================================= */

router.get("/risk/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const paper =
    paperTrader.snapshot(tenantId);

  const risk =
    riskManager.evaluate({

      tenantId,
      equity:paper.equity,
      volatility:paper.volatility || 0,
      trades:paper.trades || [],
      ts:Date.now()

    });

  return res.json({
    ok:true,
    tenantId,
    risk
  });

});

/* =========================================================
PORTFOLIO
========================================================= */

router.get("/portfolio/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  const paper =
    paperTrader.snapshot(tenantId);

  const portfolio =
    portfolioManager.snapshot?.(tenantId) || {};

  return res.json({
    ok:true,
    tenantId,
    portfolio
  });

});

/* =========================================================
AI
========================================================= */

router.get("/ai/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const snapshot =
    aiBrain.getSnapshot?.() || {};

  return res.json({
    ok:true,
    snapshot
  });

});

/* =========================================================
ROUTER HEALTH
========================================================= */

router.get("/router/health",
requireRole(ADMIN),
(req,res)=>{

  let health = {};

  try{
    health = exchangeRouter.getHealth();
  }catch{}

  return res.json({
    ok:true,
    router:health
  });

});

/* =========================================================
UNIFIED DASHBOARD
========================================================= */

router.get("/dashboard/snapshot",
requireRole(ADMIN,MANAGER),
(req,res)=>{

  const tenantId = req.tenant?.id;

  if(!tenantId)
    return res.status(400).json({ok:false,error:"Missing tenant"});

  marketEngine.registerTenant(tenantId);

  const paper =
    paperTrader.snapshot(tenantId);

  const live =
    liveTrader.snapshot?.(tenantId) || {};

  const risk =
    riskManager.evaluate({

      tenantId,
      equity:paper.equity,
      volatility:paper.volatility || 0,
      trades:paper.trades || [],
      ts:Date.now()

    });

  const price =
    marketEngine.getPrice(tenantId,"BTCUSDT");

  return res.json({

    ok:true,
    tenantId,

    market:{
      BTCUSDT:price
    },

    paper:paper,

    live:live,

    risk,

    router:
      exchangeRouter.getHealth?.() || {},

    ai:
      aiBrain.getSnapshot?.() || {}

  });

});

/* ========================================================= */

module.exports = router;
