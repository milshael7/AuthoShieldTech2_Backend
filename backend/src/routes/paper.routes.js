// backend/src/routes/paper.routes.js
// Paper Engine API — Institutional Hardened
// Auth Required • Tenant Safe • Engine Aligned

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const paperTrader = require("../services/paperTrader");

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

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || "").trim();

  // If no key configured → allow
  if (!key) return true;

  const sent = String(req.headers["x-reset-key"] || "").trim();
  return !!sent && sent === key;
}

/* =========================================================
   STATUS
========================================================= */

// GET /api/paper/status
router.get("/status", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = paperTrader.snapshot(tenantId);

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
   RESET
========================================================= */

// POST /api/paper/reset
router.post("/reset", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: "Reset blocked. Invalid or missing x-reset-key.",
      });
    }

    paperTrader.hardReset(tenantId);

    return res.json({
      ok: true,
      message: "Paper trader reset complete",
      snapshot: paperTrader.snapshot(tenantId),
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
   CONFIG VIEW (READ-ONLY)
========================================================= */

// GET /api/paper/config
router.get("/config", (req, res) => {
  try {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snap = paperTrader.snapshot(tenantId);

    const config = {
      startBalance: Number(process.env.PAPER_START_BALANCE || 100000),
      warmupTicks: Number(process.env.PAPER_WARMUP_TICKS || 250),

      feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),
      slippageBp: Number(process.env.PAPER_SLIPPAGE_BP || 8),
      spreadBp: Number(process.env.PAPER_SPREAD_BP || 6),

      cooldownMs: Number(process.env.PAPER_COOLDOWN_MS || 12000),
      maxTradesPerDay: Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40),
      maxDrawdownPct: Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25),
    };

    return res.json({
      ok: true,
      config,
      limits: snap?.limits || {},
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
   CONFIG UPDATE BLOCK
========================================================= */

// POST /api/paper/config
router.post("/config", (req, res) => {
  return res.status(409).json({
    ok: false,
    error:
      "Runtime config updates are not supported. Set PAPER_* env variables and restart.",
  });
});

module.exports = router;
