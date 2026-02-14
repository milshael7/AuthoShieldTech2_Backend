// backend/src/routes/live.routes.js
// Phase 9 — LIVE ROUTES (Observability Upgrade)
// Tenant Safe • Engine Telemetry Enabled • Hardened Signal Handling

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const liveTrader = require("../services/liveTrader");

/* ================= TENANT HELPER ================= */

function getTenantId(req) {
  return req.tenant?.id || req.tenantId || null;
}

/* =========================================================
   STATUS (PUBLIC — ENGINE SAFE)
========================================================= */

router.get("/status", (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
      });
    }

    const snap = liveTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      snapshot: snap,
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
   TELEMETRY (NEW)
   Provides structured engine observability
========================================================= */

router.get("/telemetry", authRequired, (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
      });
    }

    const snap = liveTrader.snapshot(tenantId);

    const telemetry = {
      running: snap.running,
      mode: snap.mode,
      enabled: snap.enabled,
      execute: snap.execute,

      stats: snap.stats,
      limits: snap.limits || null,

      intentCount: snap.intents?.length || 0,
      tradeCount: snap.trades?.length || 0,

      lastDecision: snap.stats?.lastDecision,
      lastReason: snap.stats?.lastReason,

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

router.post("/start", authRequired, (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
      });
    }

    liveTrader.start(tenantId);

    return res.json({
      ok: true,
      message: "Live trader started.",
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

router.post("/stop", authRequired, (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
      });
    }

    liveTrader.stop(tenantId);

    return res.json({
      ok: true,
      message: "Live trader stopped.",
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
   PUSH SIGNAL (HARDENED)
========================================================= */

router.post("/signal", authRequired, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
      });
    }

    if (typeof liveTrader.pushSignal !== "function") {
      return res.status(501).json({
        ok: false,
        error: "pushSignal not implemented in current engine version.",
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
