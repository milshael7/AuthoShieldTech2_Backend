// backend/src/routes/security.routes.js
// Enterprise Security Firewall — Hardened v7
// Deterministic Tenant Scope • Manager Scope • Memory Bounded • Blueprint Aligned

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const { getActiveSessionCount } = require("../lib/sessionStore");

const MAX_SECURITY_EVENTS = 2000;

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
    // Admin global mode
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
  if (companyIds === null) return items; // Admin global
  return items.filter(i => companyIds.includes(String(i.companyId)));
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

    let level = "Low";
    if (riskScore > 60) level = "High";
    else if (riskScore > 30) level = "Medium";

    return res.json({ ok: true, riskScore, level });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   AUTH REQUIRED BELOW
========================================================= */

router.use(authRequired);

/* =========================================================
   POSTURE SUMMARY (SCOPED)
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const db = readDb();

    const vulnerabilitiesArr = normalizeArray(db.vulnerabilities);
    const usersArr = normalizeArray(db.users);

    const companyScope = getScopedCompanyIds(req);

    const scopedVulns = scopeByCompany(vulnerabilitiesArr, companyScope);
    const scopedUsers = scopeByCompany(usersArr, companyScope);

    const critical = scopedVulns.filter(v => v.severity === "critical").length;
    const high = scopedVulns.filter(v => v.severity === "high").length;
    const medium = scopedVulns.filter(v => v.severity === "medium").length;
    const low = scopedVulns.filter(v => v.severity === "low").length;

    let riskScore = 100 - (critical * 15 + high * 8 + medium * 4 + low);
    riskScore = Math.max(5, Math.min(100, riskScore));

    return res.json({
      ok: true,
      scope: companyScope === null ? "global" : "tenant",
      totalUsers: scopedUsers.length,
      riskScore: Math.round(riskScore),
      critical,
      high,
      medium,
      low,
      timestamp: Date.now(),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   POSTURE RECENT (Blueprint Required)
========================================================= */

router.get("/posture-recent", (req, res) => {
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
      events: events.slice(0, 20)
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ACTIVE SESSION MONITOR
========================================================= */

router.get("/sessions", (req, res) => {
  try {
    const activeSessions = getActiveSessionCount(req.user.id);

    return res.json({
      ok: true,
      userId: req.user.id,
      activeSessions,
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

    // Memory bound
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
