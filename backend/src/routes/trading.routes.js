// ==========================================================
// FILE: backend/src/routes/trading.routes.js
// Institutional Trading Control API — STABLE ENTERPRISE v9
//
// FIXES
// - Manual orders now mutate real live engine state
// - Better normalized response shape for orders
// - Added analytics endpoint bridge for frontend compatibility
// - Added tenant-safe market registration on key reads
// - Added learning/brain safety fallbacks
// - Keeps config, telemetry, snapshot, status stable
// ==========================================================

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");

const paperTrader = require("../services/paperTrader");
const executionEngine = require("../services/executionEngine");
const marketEngine = require("../services/marketEngine");

const aiBrain = require("../../brain/aiBrain");
const memoryBrain = require("../../brainMemory/memoryBrain");

const { readDb, writeDb } = require("../lib/db");

/* ================= ROLES ================= */

const ADMIN = "Admin";
const MANAGER = "Manager";

/* =========================================================
TENANT SAFE ACCESS
========================================================= */

function getTenantId(req) {
  return req.tenant?.id || req.user?.companyId || req.user?.id || null;
}

function normalizeExecResults(exec) {
  if (Array.isArray(exec?.results)) return exec.results;
  if (exec?.result) return [exec.result];
  return [];
}

function getAnalyticsStore(req) {
  return req.app?.locals?.tradingAnalytics || global.tradingAnalytics || null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getItemTime(item) {
  const raw =
    item?.closedAt ??
    item?.time ??
    item?.createdAt ??
    item?.updatedAt ??
    item?.timestamp ??
    item?.date ??
    null;

  if (!raw) return null;

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  const n = Number(raw);
  if (Number.isFinite(n)) {
    const dn = new Date(n);
    return Number.isNaN(dn.getTime()) ? null : dn;
  }

  return null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function emptyPeriod() {
  return {
    wins: 0,
    losses: 0,
    breakeven: 0,
    trades: 0,
    closedTrades: 0,
    pnl: 0,
    grossWinPnl: 0,
    grossLossPnl: 0,
    avgPnl: 0,
    winRate: 0,
    profitFactor: 0,
    resets: 0,
    logins: 0,
  };
}

function finalizePeriod(period) {
  const closedTrades = safeNum(period.closedTrades, 0);
  const grossWinPnl = safeNum(period.grossWinPnl, 0);
  const grossLossPnlAbs = Math.abs(safeNum(period.grossLossPnl, 0));

  return {
    ...period,
    avgPnl: closedTrades > 0 ? safeNum(period.pnl, 0) / closedTrades : 0,
    winRate:
      closedTrades > 0 ? (safeNum(period.wins, 0) / closedTrades) * 100 : 0,
    profitFactor:
      grossLossPnlAbs > 0
        ? grossWinPnl / grossLossPnlAbs
        : grossWinPnl > 0
          ? grossWinPnl
          : 0,
  };
}

function isTradeClosed(trade) {
  if (!trade || typeof trade !== "object") return false;

  if (trade.pnl !== undefined && trade.pnl !== null) return true;

  const status = String(trade.status || trade.state || "").toUpperCase();
  if (["CLOSED", "FILLED", "EXITED", "COMPLETED", "SETTLED"].includes(status)) {
    return true;
  }

  const action = String(trade.action || trade.type || trade.event || "").toUpperCase();
  if (action.includes("CLOSE") || action.includes("EXIT")) {
    return true;
  }

  return false;
}

function classifyTradeOutcome(trade) {
  const pnl = safeNum(trade?.pnl, 0);
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "breakeven";
}

function addTradeToBucket(bucket, trade) {
  bucket.trades += 1;

  if (!isTradeClosed(trade)) return;

  const pnl = safeNum(trade?.pnl, 0);
  bucket.closedTrades += 1;
  bucket.pnl += pnl;

  const outcome = classifyTradeOutcome(trade);

  if (outcome === "win") {
    bucket.wins += 1;
    bucket.grossWinPnl += pnl;
  } else if (outcome === "loss") {
    bucket.losses += 1;
    bucket.grossLossPnl += pnl;
  } else {
    bucket.breakeven += 1;
  }
}

function buildTradeHistory(tradesInput, resetsInput = [], loginsInput = []) {
  const trades = asArray(tradesInput);
  const resets = asArray(resetsInput);
  const logins = asArray(loginsInput);

  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const yearStart = startOfYear(now);

  const today = emptyPeriod();
  const week = emptyPeriod();
  const month = emptyPeriod();
  const year = emptyPeriod();
  const allTime = emptyPeriod();

  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();

  for (const trade of trades) {
    const tradeDate = getItemTime(trade);

    addTradeToBucket(allTime, trade);

    if (!tradeDate) continue;

    const dayKey = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, "0")}-${String(tradeDate.getDate()).padStart(2, "0")}`;
    const monthKey = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, "0")}`;
    const weekBase = startOfWeek(tradeDate);
    const weekKey = `${weekBase.getFullYear()}-${String(weekBase.getMonth() + 1).padStart(2, "0")}-${String(weekBase.getDate()).padStart(2, "0")}`;

    const dailyBucket = dailyMap.get(dayKey) || { date: dayKey, ...emptyPeriod() };
    addTradeToBucket(dailyBucket, trade);
    dailyMap.set(dayKey, dailyBucket);

    const weeklyBucket = weeklyMap.get(weekKey) || { date: weekKey, ...emptyPeriod() };
    addTradeToBucket(weeklyBucket, trade);
    weeklyMap.set(weekKey, weeklyBucket);

    const monthlyBucket = monthlyMap.get(monthKey) || { date: monthKey, ...emptyPeriod() };
    addTradeToBucket(monthlyBucket, trade);
    monthlyMap.set(monthKey, monthlyBucket);

    if (tradeDate >= todayStart) addTradeToBucket(today, trade);
    if (tradeDate >= weekStart) addTradeToBucket(week, trade);
    if (tradeDate >= monthStart) addTradeToBucket(month, trade);
    if (tradeDate >= yearStart) addTradeToBucket(year, trade);
  }

  function countEventsInRange(events, rangeStart) {
    return events.filter((item) => {
      const d = getItemTime(item);
      return d && d >= rangeStart;
    }).length;
  }

  today.resets = countEventsInRange(resets, todayStart);
  today.logins = countEventsInRange(logins, todayStart);

  week.resets = countEventsInRange(resets, weekStart);
  week.logins = countEventsInRange(logins, weekStart);

  month.resets = countEventsInRange(resets, monthStart);
  month.logins = countEventsInRange(logins, monthStart);

  year.resets = countEventsInRange(resets, yearStart);
  year.logins = countEventsInRange(logins, yearStart);

  allTime.resets = resets.length;
  allTime.logins = logins.length;

  return {
    today: finalizePeriod(today),
    week: finalizePeriod(week),
    month: finalizePeriod(month),
    year: finalizePeriod(year),
    allTime: finalizePeriod(allTime),
    daily: Array.from(dailyMap.values())
      .map(finalizePeriod)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-30),
    weekly: Array.from(weeklyMap.values())
      .map(finalizePeriod)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-16),
    monthly: Array.from(monthlyMap.values())
      .map(finalizePeriod)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-12),
  };
}

/* =========================================================
AI CONFIG
========================================================= */

function getAIConfig(tenantId) {
  const db = readDb();

  db.tradingConfig = db.tradingConfig || {};

  if (!db.tradingConfig[tenantId]) {
    db.tradingConfig[tenantId] = {
      enabled: true,
      tradingMode: "paper",
      maxTrades: 5,
      riskPercent: 1.5,
      positionMultiplier: 1,
      strategyMode: "Balanced",
    };

    writeDb(db);
  }

  return db.tradingConfig[tenantId];
}

/* =========================================================
AUTH
========================================================= */

router.use(authRequired);

/* =========================================================
CONTROL ROOM SNAPSHOT
========================================================= */

router.get(
  "/snapshot",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    marketEngine.registerTenant(tenantId);

    const snapshot = paperTrader.snapshot(tenantId) || {};

    return res.json({
      ok: true,
      snapshot,
    });
  }
);

/* =========================================================
AI DECISIONS
========================================================= */

router.get(
  "/decisions",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    const decisions = paperTrader.getDecisions(tenantId) || [];

    return res.json({
      ok: true,
      decisions,
    });
  }
);

/* =========================================================
CURRENT PRICE
========================================================= */

router.get(
  "/price",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    marketEngine.registerTenant(tenantId);

    const price = marketEngine.getPrice(tenantId, "BTCUSDT");

    return res.json({
      ok: true,
      price: Number(price || 0),
    });
  }
);

/* =========================================================
MANUAL PAPER ORDER
========================================================= */

router.post(
  "/order",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    const {
      symbol,
      side,
      price,
      risk,
      size,
      qty,
      slot,
      confidence,
      stopLoss,
      takeProfit,
      closePct,
    } = req.body || {};

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    if (!symbol || !side) {
      return res.status(400).json({ ok: false, error: "Missing order fields" });
    }

    try {
      marketEngine.registerTenant(tenantId);

      const marketPrice =
        marketEngine.getPrice?.(tenantId, String(symbol).toUpperCase()) ||
        Number(price) ||
        0;

      if (!Number.isFinite(Number(marketPrice)) || Number(marketPrice) <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Market price unavailable",
        });
      }

      const state = paperTrader.getState(tenantId);

      const exec = executionEngine.executePaperOrder({
        tenantId,
        symbol: String(symbol).toUpperCase(),
        action: String(side).toUpperCase(),
        price: Number(marketPrice),
        riskPct: Number.isFinite(Number(risk)) ? Number(risk) : 0.01,
        qty: Number.isFinite(Number(size)) ? Number(size) : Number(qty || 0),
        slot,
        confidence: Number.isFinite(Number(confidence))
          ? Number(confidence)
          : undefined,
        stopLoss: Number.isFinite(Number(stopLoss))
          ? Number(stopLoss)
          : undefined,
        takeProfit: Number.isFinite(Number(takeProfit))
          ? Number(takeProfit)
          : undefined,
        closePct: Number.isFinite(Number(closePct))
          ? Number(closePct)
          : undefined,
        state,
        ts: Date.now(),
      });

      const results = normalizeExecResults(exec);

      return res.json({
        ok: true,
        result: exec?.result || results[0] || null,
        results,
        snapshot: paperTrader.snapshot(tenantId),
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err.message),
      });
    }
  }
);

/* =========================================================
ENGINE HEALTH
========================================================= */

function getEngineHealth(tenantId) {
  try {
    const snap = paperTrader.snapshot(tenantId);
    const ticks = snap?.executionStats?.ticks || 0;
    const decisions = snap?.executionStats?.decisions || 0;

    if (ticks > 0 || decisions > 0) return "RUNNING";

    return "STARTING";
  } catch {
    return "UNKNOWN";
  }
}

/* =========================================================
ENGINE TELEMETRY
========================================================= */

function getTelemetry(tenantId) {
  try {
    const snap = paperTrader.snapshot(tenantId);
    const stats = snap?.executionStats || {};

    return {
      ticks: stats.ticks || 0,
      decisions: stats.decisions || 0,
      trades: stats.trades || 0,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  } catch {
    return {
      ticks: 0,
      decisions: 0,
      trades: 0,
      memoryMb: 0,
    };
  }
}

/* =========================================================
AI BRAIN SNAPSHOT (OUTSIDE BRAIN)
========================================================= */

router.get(
  "/brain",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    try {
      const brain =
        typeof aiBrain.getSnapshot === "function"
          ? aiBrain.getSnapshot(tenantId)
          : {};

      return res.json({
        ok: true,
        brain,
      });
    } catch (err) {
      return res.json({
        ok: false,
        error: String(err.message),
      });
    }
  }
);

/* =========================================================
LEARNING MEMORY
========================================================= */

router.get(
  "/learning",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    try {
      const mem =
        typeof memoryBrain.snapshot === "function"
          ? memoryBrain.snapshot(tenantId)
          : {};

      return res.json({
        ok: true,
        memory: mem,
      });
    } catch (err) {
      return res.json({
        ok: false,
        error: String(err.message),
      });
    }
  }
);

/* =========================================================
AI STATUS
========================================================= */

router.get(
  "/status",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    const engine = getEngineHealth(tenantId);
    const telemetry = getTelemetry(tenantId);

    return res.json({
      ok: true,
      engine,
      telemetry,
    });
  }
);

/* =========================================================
AI CONFIG
========================================================= */

router.get(
  "/config",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    const config = getAIConfig(tenantId);
    const engine = getEngineHealth(tenantId);
    const telemetry = getTelemetry(tenantId);

    return res.json({
      ok: true,
      config,
      engine,
      telemetry,
    });
  }
);

router.post(
  "/config",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    const tenantId = getTenantId(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Missing tenant" });
    }

    const db = readDb();
    db.tradingConfig = db.tradingConfig || {};

    const cfg = getAIConfig(tenantId);

    const {
      enabled,
      tradingMode,
      maxTrades,
      riskPercent,
      positionMultiplier,
      strategyMode,
    } = req.body || {};

    if (enabled !== undefined) cfg.enabled = Boolean(enabled);
    cfg.tradingMode = tradingMode || "paper";
    cfg.maxTrades = Number(maxTrades || 5);
    cfg.riskPercent = Number(riskPercent || 1.5);
    cfg.positionMultiplier = Number(positionMultiplier || 1);
    cfg.strategyMode = strategyMode || "Balanced";

    db.tradingConfig[tenantId] = cfg;

    writeDb(db);

    const engine = getEngineHealth(tenantId);
    const telemetry = getTelemetry(tenantId);

    return res.json({
      ok: true,
      config: cfg,
      engine,
      telemetry,
    });
  }
);

/* =========================================================
ANALYTICS BRIDGE
PURPOSE
---------------------------------------------------------
Keeps older frontend panels working if they still call:
- /api/ai/analytics
- /api/trading/analytics

This reads from the same in-memory analytics store initialized
in server.js and synced from paperTrader/server broadcast flow.
========================================================= */

router.get(
  "/analytics",
  requireRole(ADMIN, MANAGER),
  (req, res) => {
    try {
      const store = getAnalyticsStore(req) || {};

      const tradeArchive = asArray(store.tradeArchive);
      const decisionArchive = asArray(store.decisionArchive);
      const recentResets = asArray(store.recentResets);
      const recentLogins = asArray(store.recentLogins);

      const history = buildTradeHistory(
        tradeArchive,
        recentResets,
        recentLogins
      );

      return res.json({
        ok: true,
        analytics: {
          ...history,
          recentResets: recentResets.slice().reverse().slice(0, 50),
          recentLogins: recentLogins.slice().reverse().slice(0, 50),
          tradeArchive: tradeArchive.slice().reverse().slice(0, 1000),
          decisionArchive: decisionArchive.slice().reverse().slice(0, 500),
        },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err?.message || "Failed to load analytics",
      });
    }
  }
);

/* ========================================================= */

module.exports = router;
