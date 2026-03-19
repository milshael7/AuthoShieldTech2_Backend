// ==========================================================
// FILE: backend/src/routes/paper.routes.js
// Paper Engine API — FULL INSTITUTIONAL STATE EXPOSURE v5.1
//
// FIXES
// - Manual orders mutate real live engine state
// - Snapshot remains read-only response layer
// - Normalized execution response shape
// - Better tenant-safe config resolution
// - Refresh/websocket/panel consistency improved
// - Added manual close route
// - Added profit protection arm/disarm routes
// - Added protection exposure in status/account/positions
// - Matched to paperTrader getState/manual protection methods
// ==========================================================

const express = require("express");
const router = express.Router();

const paperTrader = require("../services/paperTrader");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");
const { readDb } = require("../lib/db");

/* =========================================================
   TENANT RESOLUTION
========================================================= */

function resolveTenant(req) {
  return req.user?.companyId || req.user?.id || null;
}

function normalizeExecResults(exec) {
  if (Array.isArray(exec?.results)) return exec.results;
  if (exec?.result) return [exec.result];
  return [];
}

function getTenantTradingConfig(tenantId) {
  const db = readDb();
  const rawConfig = db?.tradingConfig || {};

  if (rawConfig && typeof rawConfig === "object" && rawConfig[tenantId]) {
    return rawConfig[tenantId] || {};
  }

  return rawConfig || {};
}

function getMarketPrice(tenantId, symbol, fallbackPrice) {
  const marketPrice =
    marketEngine.getPrice?.(tenantId, symbol) ||
    Number(fallbackPrice) ||
    0;

  return Number.isFinite(Number(marketPrice)) ? Number(marketPrice) : 0;
}

/* =========================================================
   STATUS
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

    const snapshot = paperTrader.snapshot(tenantId);

    if (!snapshot) {
      return res.json({
        ok: true,
        engine: "IDLE",
        snapshot: null,
      });
    }

    const tradingConfig = getTenantTradingConfig(tenantId);
    const decisions = paperTrader.getDecisions?.(tenantId) || [];
    const lastDecision = decisions.length
      ? decisions[decisions.length - 1]
      : null;

    const engineState = {
      mode: tradingConfig.tradingMode || "paper",
      enabled: tradingConfig.enabled ?? true,
      riskPercent: tradingConfig.riskPercent ?? 1.5,
      maxTrades: tradingConfig.maxTrades ?? 5,
      positionMultiplier: tradingConfig.positionMultiplier ?? 1,
      strategyMode: tradingConfig.strategyMode || "Balanced",
    };

    const brainState = {
      lastAction: lastDecision?.action || "WAIT",
      smoothedConfidence: Number(lastDecision?.confidence || 0),
      edgeMomentum: Number(lastDecision?.edge || 0),
      winStreak: Number(snapshot?.realized?.wins || 0),
      lossStreak: Number(snapshot?.realized?.losses || 0),
    };

    return res.json({
      ok: true,
      engine:
        Number(snapshot?.executionStats?.ticks || 0) > 0
          ? "RUNNING"
          : "IDLE",
      engineState,
      brainState,
      executionStats: snapshot.executionStats || {},
      protection: snapshot?.protection || null,
      snapshot,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Paper engine unavailable",
    });
  }
});

/* =========================================================
   ACCOUNT
========================================================= */

router.get("/account", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = paperTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      account: {
        equity: Number(snapshot?.equity || 0),
        cashBalance: Number(snapshot?.cashBalance || 0),
        availableCapital: Number(snapshot?.availableCapital || 0),
        lockedCapital: Number(snapshot?.lockedCapital || 0),
        totalCapital:
          Number(snapshot?.totalCapital) ||
          Number(snapshot?.cashBalance || 0) +
            Number(snapshot?.lockedCapital || 0),
        realized: snapshot?.realized || {
          wins: 0,
          losses: 0,
          net: 0,
          fees: 0,
        },
      },
      protection: snapshot?.protection || null,
      snapshot,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Paper account unavailable",
    });
  }
});

/* =========================================================
   POSITIONS
========================================================= */

router.get("/positions", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = paperTrader.snapshot(tenantId);

    const positions = snapshot?.positions || {
      structure: null,
      scalp: null,
    };

    const openPositions = Object.entries(positions)
      .filter(([, pos]) => !!pos)
      .map(([slot, pos]) => ({
        slot,
        ...pos,
      }));

    return res.json({
      ok: true,
      position: snapshot?.position || null,
      positions,
      protection: snapshot?.protection || null,
      openPositions,
      count: openPositions.length,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Paper positions unavailable",
    });
  }
});

/* =========================================================
   ORDERS / TRADES
========================================================= */

router.get("/orders", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const snapshot = paperTrader.snapshot(tenantId);
    const trades = Array.isArray(snapshot?.trades) ? snapshot.trades : [];

    return res.json({
      ok: true,
      orders: trades,
      trades,
      count: trades.length,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Paper orders unavailable",
    });
  }
});

/* =========================================================
   DECISIONS
========================================================= */

router.get("/decisions", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const decisions = paperTrader.getDecisions?.(tenantId) || [];

    return res.json({
      ok: true,
      decisions,
      count: decisions.length,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Decision stream unavailable",
    });
  }
});

/* =========================================================
   RESET
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

    paperTrader.hardReset(tenantId);

    return res.json({
      ok: true,
      snapshot: paperTrader.snapshot(tenantId),
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Paper reset failed",
    });
  }
});

/* =========================================================
   MANUAL ORDER (SAFE ROUTING, LIVE STATE)
========================================================= */

router.post("/order", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const {
      symbol,
      side,
      size,
      price,
      slot,
      riskPct,
      confidence,
      stopLoss,
      takeProfit,
    } = req.body || {};

    if (!symbol || !side) {
      return res.status(400).json({
        ok: false,
        error: "Invalid order payload",
      });
    }

    const normalizedSide = String(side || "").toUpperCase();
    const allowedSides = new Set(["BUY", "SELL", "CLOSE"]);

    if (!allowedSides.has(normalizedSide)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid order side",
      });
    }

    if (typeof paperTrader.getState !== "function") {
      return res.status(500).json({
        ok: false,
        error: "Paper trader live state accessor missing",
      });
    }

    const marketPrice = getMarketPrice(tenantId, symbol, price);

    if (!marketPrice) {
      return res.status(400).json({
        ok: false,
        error: "Market price unavailable",
      });
    }

    const liveState = paperTrader.getState(tenantId);

    const exec = executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: normalizedSide,
      price: marketPrice,
      qty: Number(size || 0),
      slot,
      riskPct: Number.isFinite(Number(riskPct))
        ? Number(riskPct)
        : undefined,
      confidence: Number.isFinite(Number(confidence))
        ? Number(confidence)
        : undefined,
      stopLoss: Number.isFinite(Number(stopLoss))
        ? Number(stopLoss)
        : undefined,
      takeProfit: Number.isFinite(Number(takeProfit))
        ? Number(takeProfit)
        : undefined,
      state: liveState,
      ts: Date.now(),
    });

    const results = normalizeExecResults(exec);
    const snapshot = paperTrader.snapshot(tenantId);

    return res.json({
      ok: true,
      result: exec?.result || results[0] || null,
      results,
      snapshot,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Paper order failed",
    });
  }
});

/* =========================================================
   MANUAL CLOSE NOW
========================================================= */

router.post("/close", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const liveState = paperTrader.getState?.(tenantId);
    const activeSymbol =
      req.body?.symbol ||
      liveState?.position?.symbol ||
      "BTCUSDT";

    const marketPrice = getMarketPrice(
      tenantId,
      activeSymbol,
      req.body?.price
    );

    const result = paperTrader.manualClosePosition(tenantId, {
      symbol: activeSymbol,
      price: marketPrice || req.body?.price,
      reason: req.body?.reason || "MANUAL_CLOSE_NOW",
      ts: Date.now(),
    });

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Manual close failed",
        snapshot: result?.snapshot || paperTrader.snapshot(tenantId),
      });
    }

    return res.json({
      ok: true,
      action: "CLOSE_NOW",
      snapshot: result.snapshot,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Manual close failed",
    });
  }
});

/* =========================================================
   ARM PROFIT PROTECTION
========================================================= */

router.post("/protect-profit", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const { symbol, slot, mode, trailPct } = req.body || {};

    const result = paperTrader.armProfitProtection(tenantId, {
      symbol,
      slot,
      mode: mode || "TRAIL_RETRACE",
      trailPct: Number.isFinite(Number(trailPct))
        ? Number(trailPct)
        : undefined,
    });

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Protect profit failed",
        snapshot: result?.snapshot || paperTrader.snapshot(tenantId),
      });
    }

    return res.json({
      ok: true,
      action: "PROTECT_PROFIT_ARM",
      protection: result.protection || result.snapshot?.protection || null,
      snapshot: result.snapshot,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Protect profit failed",
    });
  }
});

/* =========================================================
   DISARM PROFIT PROTECTION
========================================================= */

router.post("/protect-profit/disable", (req, res) => {
  try {
    const tenantId = resolveTenant(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant context",
      });
    }

    const { symbol, slot } = req.body || {};

    const result = paperTrader.disarmProfitProtection(tenantId, {
      symbol,
      slot,
    });

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Disable protect profit failed",
        snapshot: result?.snapshot || paperTrader.snapshot(tenantId),
      });
    }

    return res.json({
      ok: true,
      action: "PROTECT_PROFIT_DISARM",
      protection: result.protection || result.snapshot?.protection || null,
      snapshot: result.snapshot,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Disable protect profit failed",
    });
  }
});

module.exports = router;
