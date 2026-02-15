// backend/src/routes/trading.routes.js
// Phase 15 — Institutional Trading Control API
// Unified Dashboard Layer • Router Health • Behavioral Telemetry
// Paper + Live + Risk + Portfolio + AI
// Tenant Safe • Role Protected • Snapshot Accurate

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

// ---------------- ROLES ----------------
const ADMIN = "Admin";
const MANAGER = "Manager";

/* =========================================================
   PUBLIC
========================================================= */

router.get("/symbols", (req, res) => {
  return res.json({
    ok: true,
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  });
});

/* =========================================================
   AUTH REQUIRED
========================================================= */

router.use(authRequired);

/* =========================================================
   PAPER
========================================================= */

router.get("/paper/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  const snapshot = paperTrader.snapshot(tenantId);

  return res.json({
    ok: true,
    tenantId,
    snapshot,
    performance: snapshot.performance,
    adaptive: snapshot.adaptive,
  });
});

router.post("/paper/reset", requireRole(ADMIN), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  paperTrader.hardReset(tenantId);

  audit({
    actorId: req.user.id,
    action: "PAPER_TRADING_RESET",
    targetType: "TradingState",
    targetId: "paper",
    companyId: tenantId,
  });

  return res.json({ ok: true });
});

/* =========================================================
   LIVE
========================================================= */

router.get("/live/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  const snapshot = liveTrader.snapshot(tenantId);

  return res.json({
    ok: true,
    tenantId,
    snapshot,
  });
});

/* =========================================================
   RISK
========================================================= */

router.get("/risk/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  const paper = paperTrader.snapshot(tenantId);

  const risk = riskManager.evaluate({
    tenantId,
    equity: paper.equity,
    volatility: paper.volatility || 0,
    trades: paper.trades || [],
    ts: Date.now(),
  });

  return res.json({
    ok: true,
    tenantId,
    risk,
  });
});

/* =========================================================
   PORTFOLIO
========================================================= */

router.get("/portfolio/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  const paper = paperTrader.snapshot(tenantId);

  const portfolio = portfolioManager.evaluate({
    tenantId,
    symbol: null,
    equity: paper.equity,
    proposedRiskPct: 0,
    paperState: paper,
    ts: Date.now(),
  });

  return res.json({
    ok: true,
    tenantId,
    portfolio,
  });
});

/* =========================================================
   AI
========================================================= */

router.get("/ai/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  return res.json({
    ok: true,
    snapshot: aiBrain.getSnapshot?.() || {},
  });
});

/* =========================================================
   ROUTER HEALTH
========================================================= */

router.get("/router/health", requireRole(ADMIN), (req, res) => {
  return res.json({
    ok: true,
    router: exchangeRouter.getHealth(),
  });
});

/* =========================================================
   UNIFIED DASHBOARD SNAPSHOT
========================================================= */

router.get("/dashboard/snapshot", requireRole(ADMIN, MANAGER), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId)
    return res.status(400).json({ ok: false, error: "Missing tenant" });

  const paper = paperTrader.snapshot(tenantId);
  const live = liveTrader.snapshot(tenantId);

  const risk = riskManager.evaluate({
    tenantId,
    equity: paper.equity,
    volatility: paper.volatility || 0,
    trades: paper.trades || [],
    ts: Date.now(),
  });

  return res.json({
    ok: true,
    tenantId,

    paper: {
      equity: paper.equity,
      unrealized: paper.unrealizedPnL,
      performance: paper.performance,
      adaptive: paper.adaptive,
    },

    live: {
      mode: live.mode,
      equity: live.equity,
      marginUsed: live.marginUsed,
      liquidation: live.liquidation,
      regime: live.regime,
      fusedSignal: live.fusedSignal,
    },

    risk,
    router: exchangeRouter.getHealth(),
    ai: aiBrain.getSnapshot?.() || {},
  });
});

/* ========================================================= */

module.exports = router;
