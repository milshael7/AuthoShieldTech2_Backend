// backend/src/routes/trading.routes.js
// Phase 10 — Institutional Trading Control API
// Paper + Live + Risk + Portfolio + AI Telemetry
// Multi-Layer Protected • Tenant Safe

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
   PROTECTED
========================================================= */

router.use(authRequired);

/* =========================================================
   PAPER
========================================================= */

router.get(
  "/paper/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = req.tenant.id;

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
    const tenantId = req.tenant.id;

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
    const tenantId = req.tenant.id;

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
    const tenantId = req.tenant.id;

    const paper = paperTrader.snapshot(tenantId);

    const risk = riskManager.evaluate({
      tenantId,
      equity: paper.equity,
      volatility: paper.volatility,
      trades: paper.trades,
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
    const tenantId = req.tenant.id;

    const paper = paperTrader.snapshot(tenantId);

    const portfolio = portfolioManager.evaluate({
      tenantId,
      symbol: paper.position?.symbol || "N/A",
      equity: paper.equity,
      proposedRiskPct: 0,
      paperState: paper,
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
      snapshot: aiBrain.getSnapshot(),
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
    const tenantId = req.tenant.id;

    const paper = paperTrader.snapshot(tenantId);
    const live = liveTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      tenantId,
      health: {
        paperRunning: paper.running,
        liveRunning: live.running,
        liveMode: live.mode,
        paperEquity: paper.equity,
        liveEquity: live.stats?.equity || null,
        halted: paper.limits?.halted || false,
      },
    });
  }
);

/* ========================================================= */

module.exports = router;
