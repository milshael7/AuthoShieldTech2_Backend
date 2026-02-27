// backend/src/routes/admin.routes.js
// AutoShield Tech — Enterprise Admin Control v10
// Deterministic • Audit-Safe • Performance-Bounded • Blueprint Aligned

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

function safeDate(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
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

    const revenue = db.revenueSummary || {};

    const totalRevenue = Number(revenue.totalRevenue || 0);
    const MRR = Number(revenue.subscriptionRevenue || 0);
    const churnRate = Number(revenue.churnRate || 0);

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
    const medium = events.filter(e => e.severity === "medium").length;

    const score = Math.min(
      100,
      critical * 25 + high * 12 + medium * 5
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_EXEC_RISK"
    });

    return res.json({
      ok: true,
      executiveRisk: {
        score,
        level:
          score >= 80
            ? "Critical"
            : score >= 50
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
      100 - (critical * 12 + high * 7 + medium * 4);

    complianceScore = Math.max(10, Math.min(100, complianceScore));

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_COMPLIANCE"
    });

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
   ACTIVATE PLAN
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
    const user = (db.users || []).find(
      u => String(u.id) === String(userId)
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    user.subscriptionStatus = "active";
    user.subscriptionTier = String(plan).toLowerCase();

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
   AUDIT PREVIEW (BOUNDED)
========================================================= */

router.get("/audit-preview", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const audit = (db.audit || []).slice(-20).reverse();

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_AUDIT_PREVIEW"
    });

    return res.json({ ok: true, events: audit });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   FULL AUDIT EXPLORER (PERF SAFE)
========================================================= */

router.get("/audit", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    let audit = db.audit || [];

    const {
      page = 1,
      limit = 25,
      actorId,
      action
    } = req.query;

    if (actorId) {
      audit = audit.filter(e =>
        String(e.actor) === String(actorId)
      );
    }

    if (action) {
      const a = normalize(action);
      audit = audit.filter(e =>
        normalize(e.action).includes(a)
      );
    }

    audit.sort((a, b) => b.seq - a.seq);

    const pageNum = Math.max(1, Number(page));
    const perPage = Math.max(1, Math.min(100, Number(limit)));
    const startIndex = (pageNum - 1) * perPage;

    const paginated = audit.slice(startIndex, startIndex + perPage);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_AUDIT_FULL"
    });

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

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_PLATFORM_HEALTH"
    });

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
