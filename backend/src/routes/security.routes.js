// backend/src/routes/security.routes.js
// Enterprise Security Firewall — ZeroTrust Enforcement v8
// Deterministic Tenant Scope • Adaptive Enforcement • Memory Bounded

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const { getActiveSessionCount } = require("../lib/sessionStore");

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

function getScopedCompanyIds(req) {
  if (isAdmin(req.user)) {
    if (!req.companyId) return null;
    return [req.companyId];
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
  return items.filter(i => companyIds.includes(String(i.companyId)));
}

/* =========================================================
   ZERO TRUST RISK CALCULATION
========================================================= */

function calculateCompanyRisk(db, companyId) {
  const events = normalizeArray(db.securityEvents)
    .filter(e => String(e.companyId) === String(companyId));

  let score = 0;

  events.forEach(e => {
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
      level: riskLevel(riskScore)
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
      c => String(c.id) === String(companyId)
    );

    if (!company) {
      return res.status(404).json({ ok: false, error: "Company not found" });
    }

    const enforcementThreshold =
      Number(threshold) || company.enforcementThreshold || DEFAULT_ENFORCEMENT_THRESHOLD;

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
        enforced
      }
    });

    return res.json({
      ok: true,
      companyId,
      riskScore,
      level: riskLevel(riskScore),
      threshold: enforcementThreshold,
      enforced,
      action,
      timestamp: Date.now()
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

    events.sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.json({
      ok: true,
      events: events.slice(0, 100)
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
        error: "Title required"
      });
    }

    const db = readDb();
    db.securityEvents = db.securityEvents || [];

    const normalizedSeverity =
      ["low", "medium", "high", "critical"].includes(
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
      detail: { eventId: newEvent.id }
    });

    return res.status(201).json({
      ok: true,
      event: newEvent
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
      vulnerabilities: vulns
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
