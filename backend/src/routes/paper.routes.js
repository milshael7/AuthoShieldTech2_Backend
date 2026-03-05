// backend/src/routes/paper.routes.js
// ==========================================================
// Paper Engine API — STABLE + WS-ALIGNED
// Single-auth • Tenant-safe • Snapshot-guarded
// ==========================================================

const express = require("express");
const router = express.Router();

const paperTrader = require("../services/paperTrader");

/* =========================================================
   TENANT RESOLUTION (MUST MATCH WS + AI LOOP)
========================================================= */

function resolveTenant(req) {
  return req.user?.companyId || req.user?.id || null;
}

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || "").trim();

  // No key configured → allow (dev)
  if (!key) return true;

  const sent = String(req.headers["x-reset-key"] || "").trim();
  return !!sent && sent === key;
}

/* =========================================================
   STATUS
   GET /api/paper/status
========================================================= */

router.get("/status", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = paperTrader.snapshot(tenantId) || {
      equity: 0,
      cashBalance: 0,
      position: null,
      trades: [],
      limits: {},
    };

    return res.json({
      ok: true,
      snapshot,
      time: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Paper engine unavailable",
    });
  }
});

/* =========================================================
   RESET (ADMIN / MANAGER SAFE)
   POST /api/paper/reset
========================================================= */

router.post("/reset", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    // Extra safety: restrict reset to admin/manager
    const role = String(req.user?.role || "").toLowerCase();
    if (role !== "admin" && role !== "manager") {
      return res.status(403).json({
        ok: false,
        error: "Reset not permitted for this role",
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

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Paper reset failed",
    });
  }
});

/* =========================================================
   CONFIG (READ ONLY)
========================================================= */

router.get("/config", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snap = paperTrader.snapshot(tenantId) || {};

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
      limits: snap.limits || {},
      time: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Paper config unavailable",
    });
  }
});

/* =========================================================
   CONFIG UPDATE BLOCK (INTENTIONAL)
========================================================= */

router.post("/config", (_req, res) => {
  return res.status(409).json({
    ok: false,
    error:
      "Runtime config updates are not supported. Set PAPER_* env variables and restart.",
  });
});

module.exports = router;
