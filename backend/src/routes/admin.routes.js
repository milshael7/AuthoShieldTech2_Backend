// Phase 37 — Hardened Admin Control + Enterprise Audit Engine + Autodev Telemetry

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

function requireFinanceOrAdmin(req, res, next) {
  if (
    req.user.role !== ADMIN_ROLE &&
    req.user.role !== FINANCE_ROLE
  ) {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only",
    });
  }
  next();
}

/* =========================================================
   SAFE HELPERS
========================================================= */

function safeDate(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 0;
  return d.getTime();
}

function normalizeAuditRow(e) {
  return {
    id: e.id || `${safeDate(e.timestamp)}-${e.actorId || "system"}`,
    timestamp: e.timestamp || e.createdAt || new Date().toISOString(),
    actorId: e.actorId || "system",
    action: e.action || "UNKNOWN",
    targetType: e.targetType || null,
    targetId: e.targetId || null,
    metadata: e.metadata || {},
  };
}

/* =========================================================
   METRICS
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const activeSubscribers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const trialUsers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "trial"
    ).length;

    const lockedUsers = usersList.filter(
      (u) => String(u.subscriptionStatus).toLowerCase() === "locked"
    ).length;

    const totalRevenue = Number(
      db.revenueSummary?.totalRevenue || 0
    );

    const MRR = Number(db.revenueSummary?.MRR || 0);
    const churnRate = Number(db.revenueSummary?.churnRate || 0);

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue,
        MRR,
        churnRate,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   EXECUTIVE RISK
========================================================= */

router.get("/executive-risk", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const incidents = db.securityEvents || [];

    const critical = incidents.filter(
      (e) => e.severity === "critical"
    ).length;

    const high = incidents.filter(
      (e) => e.severity === "high"
    ).length;

    const score = Math.min(100, critical * 20 + high * 10);

    res.json({
      ok: true,
      executiveRisk: {
        score,
        level:
          score > 75
            ? "Critical"
            : score > 40
            ? "Elevated"
            : "Stable",
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   FULL AUDIT EXPLORER — HARDENED
========================================================= */

router.get("/audit", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    let audit = db.audit || db.auditEvents || [];
    audit = audit.map(normalizeAuditRow);

    const {
      page = 1,
      limit = 25,
      actorId,
      action,
      startDate,
      endDate,
      search,
    } = req.query;

    /* ---------- Filters ---------- */

    if (actorId) {
      audit = audit.filter(
        (e) => String(e.actorId) === String(actorId)
      );
    }

    if (action) {
      const a = String(action).toLowerCase();
      audit = audit.filter((e) =>
        String(e.action).toLowerCase().includes(a)
      );
    }

    if (startDate) {
      const start = safeDate(startDate);
      audit = audit.filter(
        (e) => safeDate(e.timestamp) >= start
      );
    }

    if (endDate) {
      const end = safeDate(endDate);
      audit = audit.filter(
        (e) => safeDate(e.timestamp) <= end
      );
    }

    if (search) {
      const s = String(search).toLowerCase();
      audit = audit.filter((e) =>
        JSON.stringify(e).toLowerCase().includes(s)
      );
    }

    /* ---------- Sort ---------- */

    audit.sort(
      (a, b) =>
        safeDate(b.timestamp) - safeDate(a.timestamp)
    );

    /* ---------- Pagination ---------- */

    const pageNum = Math.max(1, Number(page));
    const perPage = Math.max(1, Math.min(100, Number(limit)));

    const startIndex = (pageNum - 1) * perPage;
    const paginated = audit.slice(
      startIndex,
      startIndex + perPage
    );

    res.json({
      ok: true,
      page: pageNum,
      total: audit.length,
      pages: Math.ceil(audit.length / perPage),
      events: paginated,
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   AUTODEV GLOBAL STATS
========================================================= */

router.get("/autodev-stats", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const totalSubscribers = usersList.filter(
      (u) => u.autoprotectEnabled === true
    ).length;

    const activeSubscribers = usersList.filter(
      (u) =>
        u.autoprotectEnabled === true &&
        String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const pastDueSubscribers = usersList.filter(
      (u) =>
        u.autoprotectEnabled === true &&
        String(u.subscriptionStatus).toLowerCase() === "pastdue"
    ).length;

    const totalAttachedCompanies = usersList.reduce(
      (sum, u) =>
        sum +
        (Array.isArray(u.managedCompanies)
          ? u.managedCompanies.length
          : 0),
      0
    );

    const automationLoadScore =
      totalAttachedCompanies > 0
        ? Math.min(
            100,
            Math.round(
              (totalAttachedCompanies /
                (totalSubscribers || 1)) *
                10
            )
          )
        : 0;

    res.json({
      ok: true,
      totalSubscribers,
      activeSubscribers,
      pastDueSubscribers,
      totalAttachedCompanies,
      automationLoadScore,
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   PLATFORM HEALTH
========================================================= */

router.get("/platform-health", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];
    const events = db.securityEvents || [];

    const activeUsers = usersList.filter(
      (u) =>
        String(u.subscriptionStatus).toLowerCase() === "active"
    ).length;

    const criticalEvents = events.filter(
      (e) => e.severity === "critical"
    ).length;

    res.json({
      ok: true,
      health: {
        systemStatus: "Operational",
        activeUsers,
        criticalEvents,
        totalEvents: events.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
