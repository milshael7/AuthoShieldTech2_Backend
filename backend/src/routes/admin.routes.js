// backend/src/routes/admin.routes.js
// Enterprise Admin Control — Hardened v9
// Deterministic Role Enforcement • Audit Safe • Blueprint Aligned

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

/* =========================================================
   HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").trim().toLowerCase();
}

function requireAdmin(req, res, next) {
  if (normalize(req.user.role) !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  writeAudit({
    actor: req.user.id,
    role: req.user.role,
    action: "ADMIN_ROUTE_ACCESS",
    detail: { path: req.originalUrl }
  });

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

  writeAudit({
    actor: req.user.id,
    role: req.user.role,
    action: "ADMIN_ROUTE_ACCESS",
    detail: { path: req.originalUrl }
  });

  next();
}

function safeDate(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
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
   AUTH REQUIRED
========================================================= */

router.use(authRequired);

/* =========================================================
   METRICS
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const users = db.users || [];

    const activeSubscribers = users.filter(
      u => normalize(u.subscriptionStatus) === "active"
    ).length;

    const trialUsers = users.filter(
      u => normalize(u.subscriptionStatus) === "trial"
    ).length;

    const lockedUsers = users.filter(
      u => normalize(u.subscriptionStatus) === "locked"
    ).length;

    const totalRevenue = Number(db.revenueSummary?.totalRevenue || 0);
    const MRR = Number(db.revenueSummary?.MRR || 0);
    const churnRate = Number(db.revenueSummary?.churnRate || 0);

    return res.json({
      ok: true,
      metrics: {
        totalUsers: users.length,
        activeSubscribers,
        trialUsers,
        lockedUsers,
        totalRevenue,
        MRR,
        churnRate,
      },
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   EXECUTIVE RISK
========================================================= */

router.get("/executive-risk", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const events = db.securityEvents || [];

    const critical = events.filter(e => e.severity === "critical").length;
    const high = events.filter(e => e.severity === "high").length;

    const score = Math.min(100, critical * 20 + high * 10);

    return res.json({
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

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   COMPLIANCE REPORT
========================================================= */

router.get("/compliance", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const vulns = db.vulnerabilities || [];

    const critical = vulns.filter(v => v.severity === "critical").length;
    const high = vulns.filter(v => v.severity === "high").length;
    const medium = vulns.filter(v => v.severity === "medium").length;

    let complianceScore =
      100 - (critical * 10 + high * 6 + medium * 3);

    complianceScore = Math.max(10, Math.min(100, complianceScore));

    return res.json({
      ok: true,
      complianceReport: {
        complianceScore,
        critical,
        high,
        medium,
      },
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ACTIVATE PLAN (Blueprint Required)
========================================================= */

router.post("/activate", requireAdmin, (req, res) => {
  try {
    const { userId, plan } = req.body || {};

    if (!userId || !plan) {
      return res.status(400).json({
        ok: false,
        error: "userId and plan required"
      });
    }

    const db = readDb();
    const user = (db.users || []).find(u => String(u.id) === String(userId));

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    user.subscriptionStatus = "Active";
    user.plan = plan;

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_PLAN_ACTIVATED",
      detail: { userId, plan }
    });

    return res.json({ ok: true });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   AUDIT PREVIEW
========================================================= */

router.get("/audit-preview", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    let audit = db.audit || db.auditEvents || [];

    audit = audit
      .map(normalizeAuditRow)
      .sort((a, b) => safeDate(b.timestamp) - safeDate(a.timestamp))
      .slice(0, 20);

    return res.json({ ok: true, events: audit });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   FULL AUDIT EXPLORER
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

    if (actorId) {
      audit = audit.filter(e => String(e.actorId) === String(actorId));
    }

    if (action) {
      const a = normalize(action);
      audit = audit.filter(e =>
        normalize(e.action).includes(a)
      );
    }

    if (startDate) {
      const start = safeDate(startDate);
      audit = audit.filter(e => safeDate(e.timestamp) >= start);
    }

    if (endDate) {
      const end = safeDate(endDate);
      audit = audit.filter(e => safeDate(e.timestamp) <= end);
    }

    if (search) {
      const s = normalize(search);
      audit = audit.filter(e =>
        JSON.stringify(e).toLowerCase().includes(s)
      );
    }

    audit.sort((a, b) =>
      safeDate(b.timestamp) - safeDate(a.timestamp)
    );

    const pageNum = Math.max(1, Number(page));
    const perPage = Math.max(1, Math.min(100, Number(limit)));
    const startIndex = (pageNum - 1) * perPage;

    const paginated = audit.slice(startIndex, startIndex + perPage);

    return res.json({
      ok: true,
      page: pageNum,
      total: audit.length,
      pages: Math.ceil(audit.length / perPage),
      events: paginated,
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
    const users = db.users || [];
    const events = db.securityEvents || [];

    const activeUsers = users.filter(
      u => normalize(u.subscriptionStatus) === "active"
    ).length;

    const criticalEvents = events.filter(
      e => e.severity === "critical"
    ).length;

    return res.json({
      ok: true,
      health: {
        systemStatus: "Operational",
        activeUsers,
        criticalEvents,
        totalEvents: events.length,
      },
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
