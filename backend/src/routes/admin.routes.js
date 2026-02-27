// backend/src/routes/admin.routes.js
// AutoShield Tech — Enterprise Admin Control v11
// Deterministic • Audit-Safe • Trend Intelligence • Snapshot-Aware

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

/* ========================================================= */

function normalize(role) {
  return String(role || "").trim().toLowerCase();
}

function requireAdmin(req, res, next) {
  if (normalize(req.user.role) !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

function requireFinanceOrAdmin(req, res, next) {
  const role = normalize(req.user.role);
  if (role !== "admin" && role !== "finance") {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only"
    });
  }
  next();
}

function daysAgo(days) {
  return Date.now() - (days * 24 * 60 * 60 * 1000);
}

/* ========================================================= */

router.use(authRequired);

/* =========================================================
   COMPLIANCE TREND
========================================================= */

router.get("/compliance-trend", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const snapshots = db.complianceSnapshots || [];

    const windowDays = Math.min(
      365,
      Math.max(7, Number(req.query.days) || 30)
    );

    const cutoff = daysAgo(windowDays);

    const filtered = snapshots
      .filter(s => new Date(s.createdAt).getTime() >= cutoff)
      .sort((a, b) =>
        new Date(a.createdAt) - new Date(b.createdAt)
      );

    if (filtered.length === 0) {
      return res.json({ ok: true, trend: [] });
    }

    const first = filtered[0].compliance.score;
    const last = filtered[filtered.length - 1].compliance.score;

    const drift = last - first;

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_COMPLIANCE_TREND",
      detail: { windowDays }
    });

    return res.json({
      ok: true,
      complianceTrend: {
        windowDays,
        drift,
        direction:
          drift > 5 ? "Improving"
          : drift < -5 ? "Degrading"
          : "Stable",
        points: filtered.map(s => ({
          date: s.createdAt,
          score: s.compliance.score
        }))
      }
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   EXECUTIVE RISK TREND
========================================================= */

router.get("/executive-risk-trend", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const snapshots = db.complianceSnapshots || [];

    const windowDays = Math.min(
      365,
      Math.max(7, Number(req.query.days) || 30)
    );

    const cutoff = daysAgo(windowDays);

    const filtered = snapshots
      .filter(s => new Date(s.createdAt).getTime() >= cutoff)
      .sort((a, b) =>
        new Date(a.createdAt) - new Date(b.createdAt)
      );

    if (filtered.length === 0) {
      return res.json({ ok: true, trend: [] });
    }

    const first = filtered[0].executiveRisk.score;
    const last = filtered[filtered.length - 1].executiveRisk.score;

    const drift = last - first;

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_EXEC_RISK_TREND",
      detail: { windowDays }
    });

    return res.json({
      ok: true,
      executiveRiskTrend: {
        windowDays,
        drift,
        direction:
          drift > 5 ? "Escalating"
          : drift < -5 ? "Reducing"
          : "Stable",
        points: filtered.map(s => ({
          date: s.createdAt,
          score: s.executiveRisk.score
        }))
      }
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   METRICS (Existing)
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const users = db.users || [];
    const revenue = db.revenueSummary || {};

    const activeSubscribers = users.filter(
      u => normalize(u.subscriptionStatus) === "active"
    ).length;

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_METRICS"
    });

    return res.json({
      ok: true,
      metrics: {
        totalUsers: users.length,
        activeSubscribers,
        totalRevenue: Number(revenue.totalRevenue || 0),
        subscriptionRevenue: Number(revenue.subscriptionRevenue || 0),
      },
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   PLATFORM HEALTH
========================================================= */

router.get("/platform-health", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_PLATFORM_HEALTH"
    });

    return res.json({
      ok: true,
      health: {
        systemStatus: "Operational",
        totalUsers: (db.users || []).length,
        totalSecurityEvents: (db.securityEvents || []).length,
        totalSnapshots: (db.complianceSnapshots || []).length
      },
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
