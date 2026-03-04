// backend/src/routes/security.routes.js
// Enterprise Security Firewall — ZeroTrust Enforcement v9
// Adds: GET /posture-summary (admin/manager safe) to eliminate 404s
// Deterministic Tenant Scope • Adaptive Enforcement • Memory Bounded

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

const MAX_SECURITY_EVENTS = 2000;
const DEFAULT_ENFORCEMENT_THRESHOLD = 75;

/* =========================================================
   HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").toLowerCase();
}

function isAdmin(user) {
  return normalize(user.role) === "admin";
}

function isManager(user) {
  return normalize(user.role) === "manager";
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

// Company scoping rules:
// - Admin: if req.companyId is set (tenant header), scope to that; else ALL
// - Manager: if managedCompanies exists, scope to those
// - Everyone else: scope to req.companyId if present, else empty
function getScopedCompanyIds(req) {
  if (isAdmin(req.user)) {
    if (!req.companyId) return null; // null = all
    return [String(req.companyId)];
  }

  if (isManager(req.user) && Array.isArray(req.user.managedCompanies)) {
    return req.user.managedCompanies.map(String);
  }

  if (req.companyId) {
    return [String(req.companyId)];
  }

  return [];
}

function scopeByCompany(items, companyIds) {
  if (companyIds === null) return items;
  return items.filter((i) => companyIds.includes(String(i.companyId)));
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

/* =========================================================
   ZERO TRUST RISK CALCULATION
========================================================= */

function calculateCompanyRisk(db, companyId) {
  const events = normalizeArray(db.securityEvents).filter(
    (e) => String(e.companyId) === String(companyId)
  );

  let score = 0;

  events.forEach((e) => {
    if (e.severity === "critical") score += 25;
    if (e.severity === "high") score += 15;
    if (e.severity === "medium") score += 8;
    if (e.severity === "low") score += 2;
    if (!e.acknowledged) score += 5;
  });

  return Math.min(100, score);
}

function riskLevel(score) {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "ELEVATED";
  if (score >= 25) return "MODERATE";
  return "LOW";
}

/* =========================================================
   PUBLIC DEVICE RISK (NO AUTH)
========================================================= */

router.post("/public-device-risk", (req, res) => {
  try {
    const { userAgent, language, timezone } = req.body || {};

    let riskScore = 10;

    if (!userAgent) riskScore += 20;
    if (!language) riskScore += 10;
    if (!timezone) riskScore += 10;

    if (String(userAgent).toLowerCase().includes("headless")) {
      riskScore += 40;
    }

    riskScore = Math.min(100, riskScore);

    return res.json({
      ok: true,
      riskScore,
      level: riskLevel(riskScore),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   AUTH REQUIRED BELOW
========================================================= */

router.use(authRequired);

/* =========================================================
   POSTURE SUMMARY (ELIMINATES 404)
   Expected by frontend: api.postureSummary() -> /api/security/posture-summary
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const db = readDb();
    const companyScope = getScopedCompanyIds(req);

    // Incidents scoped
    let incidents = normalizeArray(db.incidents);
    incidents = scopeByCompany(incidents, companyScope);

    // Security events scoped
    let events = normalizeArray(db.securityEvents);
    events = scopeByCompany(events, companyScope);

    // Vulnerabilities scoped
    let vulns = normalizeArray(db.vulnerabilities);
    vulns = scopeByCompany(vulns, companyScope);

    const criticalAlerts = events.filter(
      (e) => String(e.severity).toLowerCase() === "critical" && !e.acknowledged
    ).length;

    // Domain-like buckets (keeps UI looking “real” even if vuln schema differs)
    // We try: v.domain, v.category, v.type, else "General"
    const buckets = {};
    vulns.forEach((v) => {
      const key =
        String(v?.domain || v?.category || v?.type || "General").trim() ||
        "General";
      if (!buckets[key]) buckets[key] = { key, label: key, coverage: 90 };
      // Lower coverage as vuln count grows
      buckets[key].coverage = clamp(100 - (buckets[key].count || 0) * 5, 10, 100);
      buckets[key].count = (buckets[key].count || 0) + 1;
    });

    const domains = Object.values(buckets).map((d) => ({
      key: d.key,
      label: d.label,
      coverage: clamp(d.coverage, 0, 100),
    }));

    // Simple score model:
    // start 100, subtract incident + event pressure, subtract critical more
    const score = clamp(
      100 -
        incidents.length * 8 -
        events.length * 2 -
        criticalAlerts * 10 -
        vulns.length * 1,
      0,
      100
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "SECURITY_POSTURE_SUMMARY_VIEWED",
      detail: {
        scope:
          companyScope === null
            ? "ALL"
            : Array.isArray(companyScope)
            ? companyScope
            : [],
      },
    });

    return res.json({
      ok: true,
      score,
      incidents: incidents.length,
      criticalAlerts,
      domains,
      time: new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ZERO TRUST ENFORCEMENT ENDPOINT
========================================================= */

router.post("/enforce/:companyId", (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ ok: false, error: "Admin only" });
    }

    const { companyId } = req.params;
    const { threshold } = req.body || {};

    const db = readDb();
    db.companies = db.companies || [];

    const company = db.companies.find(
      (c) => String(c.id) === String(companyId)
    );

    if (!company) {
      return res.status(404).json({ ok: false, error: "Company not found" });
    }

    const enforcementThreshold =
      Number(threshold) ||
      company.enforcementThreshold ||
      DEFAULT_ENFORCEMENT_THRESHOLD;

    const riskScore = calculateCompanyRisk(db, companyId);

    let enforced = false;
    let action = "NO_ACTION";

    if (riskScore >= enforcementThreshold) {
      company.status = "Locked";
      company.lockReason = "ZeroTrust enforcement";
      company.lockedAt = new Date().toISOString();
      enforced = true;
      action = "COMPANY_LOCKED";
    }

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ZEROTRUST_ENFORCEMENT",
      detail: {
        companyId,
        riskScore,
        threshold: enforcementThreshold,
        enforced,
      },
    });

    return res.json({
      ok: true,
      companyId,
      riskScore,
      level: riskLevel(riskScore),
      threshold: enforcementThreshold,
      enforced,
      action,
      timestamp: Date.now(),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   SECURITY EVENTS (SCOPED)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const companyScope = getScopedCompanyIds(req);

    let events = normalizeArray(db.securityEvents);
    events = scopeByCompany(events, companyScope);

    events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({
      ok: true,
      events: events.slice(0, 100),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   CREATE SECURITY EVENT
========================================================= */

router.post("/events", (req, res) => {
  try {
    const { title, description, severity = "low" } = req.body;

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Title required",
      });
    }

    const db = readDb();
    db.securityEvents = db.securityEvents || [];

    const normalizedSeverity = ["low", "medium", "high", "critical"].includes(
      String(severity).toLowerCase()
    )
      ? String(severity).toLowerCase()
      : "low";

    const newEvent = {
      id: Date.now().toString(),
      title,
      description: description || "",
      severity: normalizedSeverity,
      acknowledged: false,
      companyId: req.companyId || null,
      createdAt: new Date().toISOString(),
    };

    db.securityEvents.push(newEvent);

    if (db.securityEvents.length > MAX_SECURITY_EVENTS) {
      db.securityEvents = db.securityEvents.slice(-MAX_SECURITY_EVENTS);
    }

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "SECURITY_EVENT_CREATED",
      detail: { eventId: newEvent.id },
    });

    return res.status(201).json({
      ok: true,
      event: newEvent,
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   VULNERABILITIES (SCOPED)
========================================================= */

router.get("/vulnerabilities", (req, res) => {
  try {
    const db = readDb();
    const companyScope = getScopedCompanyIds(req);

    let vulns = normalizeArray(db.vulnerabilities);
    vulns = scopeByCompany(vulns, companyScope);

    return res.json({
      ok: true,
      vulnerabilities: vulns,
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
