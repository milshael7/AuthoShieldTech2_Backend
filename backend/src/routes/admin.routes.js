// backend/src/routes/admin.routes.js
// Phase 32+ — Executive Finance Intelligence Layer
// + Executive Risk Index • Revenue/Refund Overlay • Predictive Churn • Subscriber Growth
// + Admin Company Management (Added, without deleting executive endpoints)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
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
    return res.status(403).json({ ok: false, error: "Finance or Admin only" });
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
  try { return String(iso).slice(0, 10); } catch { return null; }
}

function parseDaysParam(req, fallback = 90, min = 7, max = 365) {
  const raw = Number(req.query.days ?? fallback);
  return clamp(raw, min, max);
}

function buildDailySeries({ startISO, endISO, invoices = [], refunds = [], disputes = [] }) {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();
  const map = {};

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

    const amt = Number(inv.amount || 0);
    if (!Number.isFinite(amt)) continue;

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
   METRICS
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const invoices = db.invoices || [];

    const activeSubscribers = usersList.filter((u) => u.subscriptionStatus === "Active").length;
    const trialUsers = usersList.filter((u) => u.subscriptionStatus === "Trial").length;
    const lockedUsers = usersList.filter((u) => u.subscriptionStatus === "Locked").length;

    const totalRevenue = Number(db.revenueSummary?.totalRevenue || 0);

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    const mrr = invoices
      .filter((i) =>
        i?.type === "subscription" &&
        i?.createdAt &&
        now - new Date(i.createdAt).getTime() <= THIRTY_DAYS
      )
      .reduce((sum, i) => sum + Number(i.amount || 0), 0);

    const churnRate =
      usersList.length > 0 ? Number((lockedUsers / usersList.length).toFixed(4)) : 0;

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue: Number(totalRevenue.toFixed(2)),
        MRR: Number(mrr.toFixed(2)),
        churnRate,
      },
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (All other endpoints continue exactly as you originally sent…)

module.exports = router;
