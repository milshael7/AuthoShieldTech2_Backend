// backend/src/routes/admin.routes.js
// Phase 32+ — Executive Finance Intelligence Layer
// + Executive Risk Index • Revenue/Refund Overlay • Predictive Churn

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");
const {
  generateComplianceReport,
  getComplianceHistory,
} = require("../services/compliance.service");

const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireFinanceOrAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE && req.user.role !== FINANCE_ROLE) {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only",
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

/* =========================================================
   HELPERS
========================================================= */

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function dayKey(iso) {
  if (!iso) return null;
  // expects ISO timestamps; tolerate Date strings
  try {
    return String(iso).slice(0, 10);
  } catch {
    return null;
  }
}

function parseDaysParam(req, fallback = 90, min = 7, max = 365) {
  const raw = Number(req.query.days ?? fallback);
  return clamp(raw, min, max);
}

function buildDailySeries({ startISO, endISO, invoices = [], refunds = [], disputes = [] }) {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();

  const map = {}; // day -> { revenue, refunds, disputes }

  function ensure(day) {
    if (!map[day]) map[day] = { revenue: 0, refunds: 0, disputes: 0 };
  }

  function inRange(ts) {
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return false;
    return t >= start && t <= end;
  }

  for (const inv of invoices) {
    if (!inv?.createdAt || !inRange(inv.createdAt)) continue;
    const day = dayKey(inv.createdAt);
    if (!day) continue;
    ensure(day);

    // invoices can include refund invoices with negative amounts in your invoice engine
    const amt = Number(inv.amount || 0);
    if (!Number.isFinite(amt)) continue;

    // treat subscription/tool/autoprotect as revenue; treat refund type separately
    if (inv.type === "refund") map[day].refunds += Math.abs(amt);
    else map[day].revenue += amt;
  }

  for (const r of refunds) {
    if (!r?.createdAt || !inRange(r.createdAt)) continue;
    const day = dayKey(r.createdAt);
    if (!day) continue;
    ensure(day);
    const amt = Math.abs(Number(r.amount || 0));
    if (Number.isFinite(amt)) map[day].refunds += amt;
  }

  for (const d of disputes) {
    if (!d?.createdAt || !inRange(d.createdAt)) continue;
    const day = dayKey(d.createdAt);
    if (!day) continue;
    ensure(day);
    const amt = Math.abs(Number(d.amount || 0));
    if (Number.isFinite(amt)) map[day].disputes += amt;
  }

  const days = Object.keys(map).sort();
  return days.map((date) => ({
    date,
    revenue: Number(map[date].revenue.toFixed(2)),
    refunds: Number(map[date].refunds.toFixed(2)),
    disputes: Number(map[date].disputes.toFixed(2)),
  }));
}

/* =========================================================
   LAYER 1 — EXECUTIVE RISK INDEX (0–100)
========================================================= */

router.get("/executive-risk", requireFinanceOrAdmin, async (req, res) => {
  try {
    const db = readDb();

    // Compliance drift + audit integrity
    const compliance = await generateComplianceReport();
    const revenueDrift = Number(
      compliance?.financialIntegrity?.revenueDrift ?? 0
    );

    const auditIntegrity = verifyAuditIntegrity();
    const auditOK = !!auditIntegrity?.ok;

    // Refund + dispute pressure (based on ledger)
    const totalRevenue = Number(db.revenueSummary?.totalRevenue || 0);
    const refundedAmount = Number(db.revenueSummary?.refundedAmount || 0);
    const disputedAmount = Number(db.revenueSummary?.disputedAmount || 0);

    const refundsRatio =
      totalRevenue > 0 ? refundedAmount / totalRevenue : 0;

    const disputesRatio =
      totalRevenue > 0 ? disputedAmount / totalRevenue : 0;

    // Subscriber / churn signals
    const usersList = db.users || [];
    const locked = usersList.filter((u) => u.subscriptionStatus === "Locked")
      .length;
    const active = usersList.filter((u) => u.subscriptionStatus === "Active")
      .length;
    const trial = usersList.filter((u) => u.subscriptionStatus === "Trial")
      .length;

    const lockedRatio =
      usersList.length > 0 ? locked / usersList.length : 0;

    // Risk scoring (simple, explainable, stable)
    let risk = 0;

    // Drift: any non-zero drift hurts; large drift hurts more
    risk += clamp(Math.abs(revenueDrift) * 2, 0, 30);

    // Audit chain failure is major
    if (!auditOK) risk += 30;

    // Refund/dispute pressure
    risk += clamp(refundsRatio * 100 * 0.35, 0, 20); // up to 20
    risk += clamp(disputesRatio * 100 * 0.5, 0, 20); // up to 20

    // Locked ratio pressure
    risk += clamp(lockedRatio * 100 * 0.25, 0, 20); // up to 20

    // Keep it bounded
    risk = clamp(risk, 0, 100);

    const level =
      risk >= 75 ? "CRITICAL" :
      risk >= 50 ? "ELEVATED" :
      risk >= 25 ? "MODERATE" :
      "LOW";

    res.json({
      ok: true,
      executiveRisk: {
        riskIndex: Number(risk.toFixed(2)),
        level,
        signals: {
          revenueDrift: Number(revenueDrift.toFixed(2)),
          auditOK,
          totalRevenue: Number(totalRevenue.toFixed(2)),
          refundedAmount: Number(refundedAmount.toFixed(2)),
          disputedAmount: Number(disputedAmount.toFixed(2)),
          refundsRatio: Number(refundsRatio.toFixed(4)),
          disputesRatio: Number(disputesRatio.toFixed(4)),
          users: {
            total: usersList.length,
            active,
            trial,
            locked,
            lockedRatio: Number(lockedRatio.toFixed(4)),
          },
        },
      },
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   LAYER 2 — REVENUE vs REFUND/DISPUTE OVERLAY (DAILY)
========================================================= */

router.get("/revenue-refund-overlay", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();

    const days = parseDaysParam(req, 90, 7, 365);
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);

    const series = buildDailySeries({
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      invoices: db.invoices || [],
      refunds: db.refunds || [],
      disputes: db.disputes || [],
    });

    const totals = series.reduce(
      (acc, d) => {
        acc.revenue += d.revenue;
        acc.refunds += d.refunds;
        acc.disputes += d.disputes;
        return acc;
      },
      { revenue: 0, refunds: 0, disputes: 0 }
    );

    res.json({
      ok: true,
      window: { days, start: start.toISOString(), end: end.toISOString() },
      totals: {
        revenue: Number(totals.revenue.toFixed(2)),
        refunds: Number(totals.refunds.toFixed(2)),
        disputes: Number(totals.disputes.toFixed(2)),
      },
      series,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   LAYER 3 — PREDICTIVE CHURN INDICATOR
========================================================= */

router.get("/predictive-churn", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const invoices = db.invoices || [];
    const refunds = db.refunds || [];
    const disputes = db.disputes || [];

    const active = usersList.filter((u) => u.subscriptionStatus === "Active")
      .length;
    const trial = usersList.filter((u) => u.subscriptionStatus === "Trial")
      .length;
    const locked = usersList.filter((u) => u.subscriptionStatus === "Locked")
      .length;

    const lockedRatio =
      usersList.length > 0 ? locked / usersList.length : 0;

    // activity: who paid in last 60 days
    const now = Date.now();
    const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
    const recentPayers = new Set(
      invoices
        .filter(
          (i) =>
            i?.userId &&
            i?.createdAt &&
            now - new Date(i.createdAt).getTime() <= SIXTY_DAYS &&
            i.type !== "refund"
        )
        .map((i) => i.userId)
    ).size;

    // pressure: refunds/disputes relative to actives
    const refundRate =
      active > 0 ? refunds.length / active : refunds.length;

    const disputeRate =
      active > 0 ? disputes.length / active : disputes.length;

    // score (0–100): explainable weights
    let score = 0;
    score += clamp(lockedRatio * 100 * 0.6, 0, 60); // locked pressure heavy
    score += clamp(refundRate * 20, 0, 20); // refund volume pressure
    score += clamp(disputeRate * 30, 0, 30); // disputes stronger signal
    if (recentPayers === 0 && (active > 0 || trial > 0)) score += 15;

    score = clamp(score, 0, 100);

    const level =
      score >= 75 ? "CRITICAL" :
      score >= 50 ? "ELEVATED" :
      score >= 25 ? "MODERATE" :
      "LOW";

    res.json({
      ok: true,
      predictiveChurn: {
        score: Number(score.toFixed(2)),
        level,
        drivers: {
          users: {
            total: usersList.length,
            active,
            trial,
            locked,
            lockedRatio: Number(lockedRatio.toFixed(4)),
          },
          recentPayers60d: recentPayers,
          refunds: { count: refunds.length, perActive: Number(refundRate.toFixed(4)) },
          disputes: { count: disputes.length, perActive: Number(disputeRate.toFixed(4)) },
        },
      },
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REFUND + DISPUTE TIMELINE
========================================================= */

router.get("/refund-dispute-timeline", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const refunds = db.refunds || [];
    const disputes = db.disputes || [];

    const dailyMap = {};

    function addEntry(entry, type) {
      if (!entry?.createdAt) return;

      const day = entry.createdAt.slice(0, 10);

      if (!dailyMap[day]) {
        dailyMap[day] = {
          refundAmount: 0,
          disputeAmount: 0,
        };
      }

      const amount = Number(entry.amount || 0);

      if (type === "refund") {
        dailyMap[day].refundAmount += amount;
      }

      if (type === "dispute") {
        dailyMap[day].disputeAmount += amount;
      }
    }

    refunds.forEach((r) => addEntry(r, "refund"));
    disputes.forEach((d) => addEntry(d, "dispute"));

    const sortedDays = Object.keys(dailyMap).sort();

    let cumulativeRefund = 0;
    let cumulativeDispute = 0;

    const result = sortedDays.map((day) => {
      cumulativeRefund += dailyMap[day].refundAmount;
      cumulativeDispute += dailyMap[day].disputeAmount;

      return {
        date: day,
        cumulativeRefund,
        cumulativeDispute,
      };
    });

    res.json({
      ok: true,
      timeline: result,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   EXISTING ROUTES PRESERVED
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const invoices = db.invoices || [];

    const activeSubscribers = usersList.filter(
      (u) => u.subscriptionStatus === "Active"
    ).length;

    // lightweight MRR (30d subscription invoices)
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const mrr = invoices
      .filter(
        (i) =>
          i.type === "subscription" &&
          i.createdAt &&
          now - new Date(i.createdAt).getTime() <= THIRTY_DAYS
      )
      .reduce((sum, i) => sum + Number(i.amount || 0), 0);

    const lockedUsers = usersList.filter(
      (u) => u.subscriptionStatus === "Locked"
    ).length;

    const churnRate =
      usersList.length > 0
        ? Number((lockedUsers / usersList.length).toFixed(4))
        : 0;

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        totalRevenue: Number(db.revenueSummary?.totalRevenue || 0),
        MRR: Number(mrr.toFixed(2)),
        churnRate,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/compliance/report", requireFinanceOrAdmin, async (req, res) => {
  try {
    const report = await generateComplianceReport();
    res.json({ ok: true, complianceReport: report });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/compliance/history", requireFinanceOrAdmin, (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const history = getComplianceHistory(limit);
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/notifications", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
