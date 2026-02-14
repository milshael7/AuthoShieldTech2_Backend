// backend/src/routes/trading.routes.js
// Trading Routes — ENGINE ALIGNED + TENANT SAFE (FINAL)

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { audit } = require("../lib/audit");

const paperTrader = require("../services/paperTrader");
const liveTrader = require("../services/liveTrader");

// ---------------- ROLES ----------------
const ADMIN = "Admin";
const MANAGER = "Manager";

/* ================= PUBLIC ================= */

router.get("/symbols", (req, res) => {
  return res.json({
    ok: true,
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  });
});

/* ================= PROTECTED ================= */

router.use(authRequired);

/* ================= PAPER ================= */

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

/* ================= LIVE ================= */

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

router.post(
  "/live/signal",
  requireRole(ADMIN),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const signal = req.body || {};

      const result = await liveTrader.pushSignal(
        tenantId,
        signal
      );

      audit({
        actorId: req.user.id,
        action: "LIVE_TRADING_SIGNAL",
        targetType: "TradingSignal",
        targetId: signal.symbol || "unknown",
        companyId: tenantId,
        metadata: {
          mode: "live",
          side: signal.side || "unknown",
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
