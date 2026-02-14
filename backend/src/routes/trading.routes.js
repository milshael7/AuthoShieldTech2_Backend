// backend/src/routes/trading.routes.js
// Institutional Trading Control API — Engine Aligned
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

router.get(
  "/paper/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    return res.json({
      ok: true,
      tenantId,
      snapshot: paperTrader.snapshot(tenantId),
    });
  }
);

router.post(
  "/paper/reset",
  requireRole(ADMIN),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    paperTrader.hardReset(tenantId);

    audit({
      actorId: req.user.id,
      action: "PAPER_TRADING_RESET",
      targetType: "TradingState",
      targetId: "paper",
      companyId: tenantId,
    });

    return res.json({ ok: true });
  }
);

/* =========================================================
   LIVE
========================================================= */

router.get(
  "/live/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    return res.json({
      ok: true,
      tenantId,
      snapshot: liveTrader.snapshot(tenantId),
    });
  }
);

/* =========================================================
   RISK TELEMETRY
========================================================= */

router.get(
  "/risk/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

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
  }
);

/* =========================================================
   PORTFOLIO TELEMETRY
========================================================= */

router.get(
  "/portfolio/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

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
  }
);

/* =========================================================
   AI BRAIN SNAPSHOT
========================================================= */

router.get(
  "/ai/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    return res.json({
      ok: true,
      snapshot: aiBrain.getSnapshot?.() || {},
    });
  }
);

/* =========================================================
   SYSTEM HEALTH
========================================================= */

router.get(
  "/system/health",
  requireRole(ADMIN),
  (req, res) => {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    const paper = paperTrader.snapshot(tenantId);
    const live = liveTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      tenantId,
      health: {
        liveMode: live.mode,
        paperEquity: paper.equity,
        liveEquity: live.equity,
        marginUsed: live.marginUsed,
        liquidation: live.liquidation,
      },
    });
  }
);

/* ========================================================= */

module.exports = router;
