// backend/src/routes/live.routes.js
// LIVE TRADING ROUTES — TENANT SAFE + ENGINE ALIGNED

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const liveTrader = require("../services/liveTrader");

/* ================= TENANT HELPER ================= */

function getTenantId(req) {
  return req.tenant?.id || req.tenantId || null;
}

/* ================= STATUS ================= */

// PUBLIC: engine status (per tenant)
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

/* ================= START ================= */

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

/* ================= STOP ================= */

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

/* ================= PUSH SIGNAL ================= */

// This is where your AI signals will go
router.post("/signal", authRequired, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context.",
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
