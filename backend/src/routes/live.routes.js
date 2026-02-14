// backend/src/routes/live.routes.js
// Live Engine API — Institutional Hardened
// Auth Required • Tenant Safe • Snapshot Accurate

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const liveTrader = require("../services/liveTrader");

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function getTenantId(req) {
  return req.tenant?.id || null;
}

/* =========================================================
   STATUS
========================================================= */

// GET /api/live/status
router.get("/status", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = liveTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      snapshot,
      time: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   TELEMETRY (ENGINE ALIGNED)
========================================================= */

// GET /api/live/telemetry
router.get("/telemetry", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snap = liveTrader.snapshot(tenantId);

    const telemetry = {
      mode: snap.mode,

      capital: {
        cash: snap.cash,
        equity: snap.equity,
      },

      margin: {
        leverage: snap.leverage,
        marginUsed: snap.marginUsed,
        maintenanceRequired: snap.maintenanceRequired,
        liquidation: snap.liquidation,
      },

      signal: snap.fusedSignal,

      positions: snap.positions,

      routerHealth: snap.routerHealth,

      timestamp: new Date().toISOString(),
    };

    return res.json({
      ok: true,
      telemetry,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   START
========================================================= */

// POST /api/live/start
router.post("/start", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    liveTrader.start(tenantId);

    return res.json({
      ok: true,
      message: "Live trader started",
      snapshot: liveTrader.snapshot(tenantId),
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   STOP
========================================================= */

// POST /api/live/stop
router.post("/stop", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    liveTrader.stop(tenantId);

    return res.json({
      ok: true,
      message: "Live trader stopped",
      snapshot: liveTrader.snapshot(tenantId),
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   PUSH SIGNAL (OPTIONAL FEATURE)
========================================================= */

// POST /api/live/signal
router.post("/signal", async (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    if (typeof liveTrader.pushSignal !== "function") {
      return res.status(501).json({
        ok: false,
        error: "pushSignal not implemented in current engine version",
      });
    }

    const result = await liveTrader.pushSignal(
      tenantId,
      req.body || {}
    );

    return res.json(result);

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
