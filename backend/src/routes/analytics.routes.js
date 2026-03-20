const express = require("express");
const router = express.Router();

/* =========================================================
TRADING ANALYTICS MEMORY ROUTE
PURPOSE
---------------------------------------------------------
Provides persistent trading analytics memory for:
- today
- week
- month
- year
- all-time
- reset history
- login history
- trade archive
- decision archive

IMPORTANT
---------------------------------------------------------
This route is designed to be tolerant of backend drift.
It attempts to read from common globals / services if they
exist, and falls back safely if they do not.

You should later connect this to your real persistence
layer or database.
========================================================= */

/* =========================================================
HELPERS
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
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
    winRate: closedTrades > 0 ? (safeNum(period.wins, 0) / closedTrades) * 100 : 0,
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
MEMORY ACCESS
---------------------------------------------------------
These are safe fallbacks.
Later you should replace these with your real DB/service.
========================================================= */

function getTradingMemory(req) {
  const app = req.app;

  const paperState =
    app?.locals?.paperState ||
    global.paperState ||
    {};

  const analyticsStore =
    app?.locals?.tradingAnalytics ||
    global.tradingAnalytics ||
    {};

  const tradeArchive =
    asArray(analyticsStore.tradeArchive).length
      ? asArray(analyticsStore.tradeArchive)
      : asArray(paperState.trades);

  const decisionArchive =
    asArray(analyticsStore.decisionArchive).length
      ? asArray(analyticsStore.decisionArchive)
      : asArray(paperState.decisions);

  const recentResets = asArray(analyticsStore.recentResets);
  const recentLogins = asArray(analyticsStore.recentLogins);

  return {
    tradeArchive,
    decisionArchive,
    recentResets,
    recentLogins,
  };
}

/* =========================================================
GET /api/analytics/trading
========================================================= */

router.get("/trading", (req, res) => {
  try {
    const {
      tradeArchive,
      decisionArchive,
      recentResets,
      recentLogins,
    } = getTradingMemory(req);

    const periods = buildTradeHistory(
      tradeArchive,
      recentResets,
      recentLogins
    );

    return res.json({
      ok: true,
      history: {
        ...periods,
        recentResets: recentResets.slice().reverse().slice(0, 50),
        recentLogins: recentLogins.slice().reverse().slice(0, 50),
        tradeArchive: tradeArchive.slice().reverse().slice(0, 1000),
        decisionArchive: decisionArchive.slice().reverse().slice(0, 500),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || "Failed to build trading analytics history",
    });
  }
});

module.exports = router;
