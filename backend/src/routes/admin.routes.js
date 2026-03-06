// backend/src/routes/admin.routes.js
// =========================================================
// AUTOSHIELD — ENTERPRISE ADMIN ROUTES v14 (SEALED)
// DETERMINISTIC • AUDIT-SAFE • QUIET MODE
// AI BRAIN EXPLORER • PLATFORM GOVERNANCE
// NO SELF-NOISE • NO SECURITY STATE AUTHORITY
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

/* ================= HELPERS ================= */

function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

function daysAgo(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
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
      error: "Finance or Admin only",
    });
  }
  next();
}

/* ================= MIDDLEWARE ================= */

router.use(authRequired);

/* =========================================================
   AI DECISION EXPLORER (READ-ONLY)
   → Frontend: BrainAdapter v17
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
      signal,
    } = req.query;

    if (userId) {
      decisions = decisions.filter(
        (d) => String(d.userId) === String(userId)
      );
    }

    if (level) {
      decisions = decisions.filter(
        (d) => normalize(d.level) === normalize(level)
      );
    }

    if (role) {
      decisions = decisions.filter(
        (d) => normalize(d.role) === normalize(role)
      );
    }

    if (companyId) {
      decisions = decisions.filter(
        (d) => String(d.companyId) === String(companyId)
      );
    }

    if (signal) {
      const s = normalize(signal);
      decisions = decisions.filter((d) =>
        (d.signals || []).some((sig) =>
          normalize(sig).includes(s)
        )
      );
    }

    decisions.sort(
      (a, b) =>
        new Date(b.timestamp || b.ts) -
        new Date(a.timestamp || a.ts)
    );

    // drift calculation (advisory only)
    let drift = null;
    if (decisions.length >= 20) {
      const avg = (arr) =>
        arr.reduce(
          (sum, d) => sum + Number(d.combinedScore || 0),
          0
        ) / arr.length;

      drift =
        avg(decisions.slice(0, 10)) -
        avg(decisions.slice(10, 20));
    }

    const pageNum = Math.max(1, Number(page));
    const perPage = Math.max(
      1,
      Math.min(100, Number(limit))
    );
    const start = (pageNum - 1) * perPage;

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_AI_DECISIONS",
    });

    return res.json({
      ok: true,
      page: pageNum,
      total: decisions.length,
      pages: Math.ceil(decisions.length / perPage),
      drift,
      decisions: decisions.slice(start, start + perPage),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   COMPLIANCE TREND (READ-ONLY)
========================================================= */

router.get(
  "/compliance-trend",
  requireFinanceOrAdmin,
  (req, res) => {
    try {
      const db = readDb();
      const snapshots = db.complianceSnapshots || [];

      const windowDays = Math.min(
        365,
        Math.max(7, Number(req.query.days) || 30)
      );

      const cutoff = daysAgo(windowDays);

      const filtered = snapshots
        .filter(
          (s) =>
            new Date(s.createdAt).getTime() >= cutoff
        )
        .sort(
          (a, b) =>
            new Date(a.createdAt) -
            new Date(b.createdAt)
        );

      if (filtered.length === 0) {
        return res.json({ ok: true, trend: [] });
      }

      const first = filtered[0].compliance.score;
      const last =
        filtered[filtered.length - 1].compliance.score;

      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "ADMIN_VIEW_COMPLIANCE_TREND",
      });

      return res.json({
        ok: true,
        complianceTrend: {
          windowDays,
          drift: last - first,
          points: filtered.map((s) => ({
            date: s.createdAt,
            score: s.compliance.score,
          })),
        },
      });
    } catch {
      return res.status(500).json({ ok: false });
    }
  }
);

/* =========================================================
   PLATFORM HEALTH (NON-SECURITY AUTHORITY)
========================================================= */

router.get("/platform-health", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_VIEW_PLATFORM_HEALTH",
    });

    return res.json({
      ok: true,
      health: {
        totalUsers: (db.users || []).length,
        totalCompanies: (db.companies || []).length,
        totalSecurityEvents:
          (db.securityEvents || []).length,
        totalSnapshots:
          (db.complianceSnapshots || []).length,
        totalAIDecisions:
          (db.brain?.decisions || []).length,
      },
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

    return res.json({
      ok: true,
      total: companies.length,
      companies,
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GLOBAL GOVERNANCE — MANAGERS
========================================================= */

router.get("/managers", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const managers = (db.users || []).filter(
      (u) => normalize(u.role) === "manager"
    );

    return res.json({
      ok: true,
      total: managers.length,
      managers,
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   CORPORATE ENTITIES (READ-ONLY)
========================================================= */

router.get(
  "/corporate-entities",
  requireAdmin,
  (req, res) => {
    try {
      const db = readDb();

      const entities = (db.companies || []).map(
        (c) => ({
          id: c.id,
          name: c.name,
          tier: c.subscriptionTier || "free",
          members: (db.users || []).filter(
            (u) => u.companyId === c.id
          ).length,
          status: c.subscriptionStatus || "active",
        })
      );

      return res.json({
        ok: true,
        entities,
      });
    } catch {
      return res.status(500).json({ ok: false });
    }
  }
);

/* =========================================================
   USER GOVERNANCE (READ-ONLY)
========================================================= */

router.get("/user-governance", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const users = db.users || [];

    return res.json({
      ok: true,
      totalUsers: users.length,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        companyId: u.companyId || null,
        subscriptionStatus:
          u.subscriptionStatus || "inactive",
      })),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
