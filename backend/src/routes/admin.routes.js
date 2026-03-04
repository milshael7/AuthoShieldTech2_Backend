// backend/src/routes/admin.routes.js
// AutoShield Tech — Enterprise Admin Control v13
// Deterministic • Audit-Safe • Trend + AI Brain Explorer
// + Global Governance Endpoints (Companies, Managers, Corporate Entities, User Governance)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
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
   AI DECISION EXPLORER
========================================================= */

router.get("/ai-decisions", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    let decisions = db.brain?.decisions || [];

    const {
      page = 1,
      limit = 25,
      userId,
      level,
      role,
      companyId,
      signal
    } = req.query;

    if (userId) {
      decisions = decisions.filter(d =>
        String(d.userId) === String(userId)
      );
    }

    if (level) {
      decisions = decisions.filter(d =>
        normalize(d.level) === normalize(level)
      );
    }

    if (role) {
      decisions = decisions.filter(d =>
        normalize(d.role) === normalize(role)
      );
    }

    if (companyId) {
      decisions = decisions.filter(d =>
        String(d.companyId) === String(companyId)
      );
    }

    if (signal) {
      const s = normalize(signal);
      decisions = decisions.filter(d =>
        (d.signals || []).some(sig =>
          normalize(sig).includes(s)
        )
      );
    }

    decisions.sort(
      (a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
    );

    let drift = null;

    if (decisions.length >= 20) {
      const last10 = decisions.slice(0, 10);
      const prev10 = decisions.slice(10, 20);

      const avg = arr =>
        arr.reduce((sum, d) => sum + d.combinedScore, 0) / arr.length;

      drift = avg(last10) - avg(prev10);
    }

    const pageNum = Math.max(1, Number(page));
    const perPage = Math.max(1, Math.min(100, Number(limit)));
    const startIndex = (pageNum - 1) * perPage;

    const paginated = decisions.slice(
      startIndex,
      startIndex + perPage
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_AI_DECISIONS"
    });

    return res.json({
      ok: true,
      page: pageNum,
      total: decisions.length,
      pages: Math.ceil(decisions.length / perPage),
      drift,
      decisions: paginated
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

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
      action: "ADMIN_VIEW_COMPLIANCE_TREND"
    });

    return res.json({
      ok: true,
      complianceTrend: {
        windowDays,
        drift,
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
        totalUsers: (db.users || []).length,
        totalCompanies: (db.companies || []).length,
        totalSecurityEvents: (db.securityEvents || []).length,
        totalSnapshots: (db.complianceSnapshots || []).length,
        totalAIDecisions: (db.brain?.decisions || []).length
      }
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GLOBAL GOVERNANCE — COMPANIES
========================================================= */

router.get("/companies", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const companies = db.companies || [];

    res.json({
      ok: true,
      total: companies.length,
      companies
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GLOBAL GOVERNANCE — MANAGERS
========================================================= */

router.get("/managers", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    const managers = (db.users || []).filter(
      u => normalize(u.role) === "manager"
    );

    res.json({
      ok: true,
      total: managers.length,
      managers
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   CORPORATE ENTITIES
========================================================= */

router.get("/corporate-entities", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    const entities = (db.companies || []).map(c => ({
      id: c.id,
      name: c.name,
      tier: c.subscriptionTier || "free",
      members: (db.users || []).filter(u => u.companyId === c.id).length,
      status: c.subscriptionStatus || "active"
    }));

    res.json({
      ok: true,
      entities
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   USER GOVERNANCE
========================================================= */

router.get("/user-governance", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const users = db.users || [];

    res.json({
      ok: true,
      totalUsers: users.length,
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        companyId: u.companyId || null,
        subscriptionStatus: u.subscriptionStatus || "inactive"
      }))
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
