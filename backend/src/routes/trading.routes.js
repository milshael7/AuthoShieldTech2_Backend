// backend/src/routes/trading.routes.js
// Trading Routes — HARDENED + TENANT SAFE
//
// Guarantees:
// - Auth required
// - Tenant-isolated
// - Admin/Manager role enforcement
// - Audited live signals
// - Safe-by-default execution

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { audit } = require("../lib/audit");

const paperTrader = require("../services/paperTrader");
const liveTrader = require("../services/liveTrader");

// ---------------- ROLES ----------------
const ADMIN = "Admin";
const MANAGER = "Manager";

// ---------------- PUBLIC ----------------

/**
 * GET /api/trading/symbols
 * Frontend helper only
 */
router.get("/symbols", (req, res) => {
  return res.json({
    ok: true,
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  });
});

// ---------------- PROTECTED ----------------
router.use(authRequired);

// ---------------- PAPER TRADING ----------------

/**
 * GET /api/trading/paper/snapshot
 * Admin + Manager
 */
router.get(
  "/paper/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    return res.json({
      ok: true,
      tenantId: req.tenant.id,
      snapshot: paperTrader.snapshot(req.tenant.id),
    });
  }
);

/**
 * POST /api/trading/paper/config
 * Admin only
 */
router.post(
  "/paper/config",
  requireRole(ADMIN),
  (req, res) => {
    const updated = paperTrader.setConfig(req.tenant.id, req.body || {});

    audit({
      actorId: req.user.id,
      action: "PAPER_TRADING_CONFIG_UPDATED",
      targetType: "TradingConfig",
      targetId: "paper",
      companyId: req.tenant.id,
      metadata: updated,
    });

    return res.json({ ok: true, config: updated });
  }
);

/**
 * POST /api/trading/paper/reset
 * Admin only
 */
router.post(
  "/paper/reset",
  requireRole(ADMIN),
  (req, res) => {
    paperTrader.hardReset(req.tenant.id);

    audit({
      actorId: req.user.id,
      action: "PAPER_TRADING_RESET",
      targetType: "TradingState",
      targetId: "paper",
      companyId: req.tenant.id,
    });

    return res.json({ ok: true });
  }
);

// ---------------- LIVE TRADING (SAFE MODE) ----------------

/**
 * GET /api/trading/live/snapshot
 * Admin + Manager
 */
router.get(
  "/live/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    return res.json({
      ok: true,
      tenantId: req.tenant.id,
      snapshot: liveTrader.snapshot(req.tenant.id),
    });
  }
);

/**
 * POST /api/trading/live/signal
 * Admin only
 *
 * Signals are:
 * - validated
 * - audited
 * - never executed unless live trading is explicitly enabled
 */
router.post(
  "/live/signal",
  requireRole(ADMIN),
  async (req, res) => {
    try {
      const signal = req.body || {};

      const result = await liveTrader.pushSignal({
        ...signal,
        tenantId: req.tenant.id,
        actorId: req.user.id,
      });

      audit({
        actorId: req.user.id,
        action: "LIVE_TRADING_SIGNAL",
        targetType: "TradingSignal",
        targetId: signal.symbol || "unknown",
        companyId: req.tenant.id,
        metadata: {
          mode: "live",
          signal: signal.type || "unknown",
        },
      });

      return res.json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e?.message || "Live trading error",
      });
    }
  }
);

module.exports = router;
