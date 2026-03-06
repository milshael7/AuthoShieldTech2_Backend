// backend/src/routes/security.routes.js
// =========================================================
// Enterprise Security Firewall — ZeroTrust Enforcement v10
// QUIET MODE • NO EVENT SPAM • NO AUDIT FLOOD
// DETERMINISTIC RESPONSES • CACHE-AWARE • PLATFORM-SAFE
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

/* ================= CONFIG ================= */

const MAX_SECURITY_EVENTS = 2000;
const DEFAULT_ENFORCEMENT_THRESHOLD = 75;

// 🔇 quiet-mode controls
const POSTURE_CACHE_TTL = 15_000; // 15s
const AUDIT_COOLDOWN = 60_000; // 1 min per user+action

/* ================= MEMORY ================= */

const postureCache = new Map(); // key -> { ts, data }
const auditCooldown = new Map(); // key -> ts

/* ================= HELPERS ================= */

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
  return Array.isArray(v) ? v : Object.values(v);
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function auditQuiet({ actor, role, action, detail }) {
  const key = `${actor}:${action}`;
  const now = Date.now();
  const last = auditCooldown.get(key) || 0;

  if (now - last < AUDIT_COOLDOWN) return;
  auditCooldown.set(key, now);

  writeAudit({ actor, role, action, detail });
}

/* ================= COMPANY SCOPE ================= */

function getScopedCompanyIds(req) {
  if (isAdmin(req.user)) {
    if (!req.companyId) return null;
    return [String(req.companyId)];
  }

  if (isManager(req.user) && Array.isArray(req.user.managedCompanies)) {
    return req.user.managedCompanies.map(String);
  }

  if (req.companyId) return [String(req.companyId)];

  return [];
}

function scopeByCompany(items, companyIds) {
  if (companyIds === null) return items;
  return items.filter((i) =>
    companyIds.includes(String(i.companyId))
  );
}

/* ================= RISK ================= */

function calculateCompanyRisk(db, companyId) {
  const events = normalizeArray(db.securityEvents).filter(
    (e) => String(e.companyId) === String(companyId)
  );

  let score = 0;

  for (const e of events) {
    if (e.severity === "critical") score += 25;
    else if (e.severity === "high") score += 15;
    else if (e.severity === "medium") score += 8;
    else score += 2;

    if (!e.acknowledged) score += 5;
  }

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
    if (String(userAgent).toLowerCase().includes("headless")) riskScore += 40;

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
   POSTURE SUMMARY — QUIET + CACHED
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const companyScope = getScopedCompanyIds(req);
    const cacheKey = `${req.user.id}:${companyScope || "ALL"}`;

    const cached = postureCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < POSTURE_CACHE_TTL) {
      return res.json(cached.data);
    }

    const db = readDb();

    let incidents = scopeByCompany(
      normalizeArray(db.incidents),
      companyScope
    );

    let events = scopeByCompany(
      normalizeArray(db.securityEvents),
      companyScope
    );

    let vulns = scopeByCompany(
      normalizeArray(db.vulnerabilities),
      companyScope
    );

    const criticalAlerts = events.filter(
      (e) =>
        String(e.severity).toLowerCase() === "critical" &&
        !e.acknowledged
    ).length;

    const buckets = {};
    for (const v of vulns) {
      const key = String(
        v?.domain || v?.category || v?.type || "General"
      ).trim();

      if (!buckets[key]) {
        buckets[key] = { key, label: key, count: 0 };
      }
      buckets[key].count++;
    }

    const domains = Object.values(buckets).map((b) => ({
      key: b.key,
      label: b.label,
      coverage: clamp(100 - b.count * 5, 10, 100),
    }));

    const score = clamp(
      100 -
        incidents.length * 8 -
        events.length * 2 -
        criticalAlerts * 10 -
        vulns.length,
      0,
      100
    );

    const payload = {
      ok: true,
      score,
      incidents: incidents.length,
      criticalAlerts,
      domains,
      time: new Date().toISOString(),
    };

    postureCache.set(cacheKey, { ts: Date.now(), data: payload });

    auditQuiet({
      actor: req.user.id,
      role: req.user.role,
      action: "SECURITY_POSTURE_SUMMARY_VIEWED",
      detail: { scope: companyScope ?? "ALL" },
    });

    return res.json(payload);
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ZERO TRUST ENFORCEMENT (QUIET)
========================================================= */

router.post("/enforce/:companyId", (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ ok: false });
    }

    const { companyId } = req.params;
    const db = readDb();
    const company = (db.companies || []).find(
      (c) => String(c.id) === String(companyId)
    );

    if (!company) {
      return res.status(404).json({ ok: false });
    }

    const threshold =
      Number(req.body?.threshold) ||
      company.enforcementThreshold ||
      DEFAULT_ENFORCEMENT_THRESHOLD;

    const riskScore = calculateCompanyRisk(db, companyId);
    let enforced = false;

    if (riskScore >= threshold && company.status !== "Locked") {
      company.status = "Locked";
      company.lockReason = "ZeroTrust enforcement";
      company.lockedAt = new Date().toISOString();
      enforced = true;
      writeDb(db);
    }

    auditQuiet({
      actor: req.user.id,
      role: req.user.role,
      action: "ZEROTRUST_ENFORCEMENT",
      detail: { companyId, riskScore, threshold, enforced },
    });

    return res.json({
      ok: true,
      companyId,
      riskScore,
      level: riskLevel(riskScore),
      threshold,
      enforced,
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   SECURITY EVENTS (READ ONLY, QUIET)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const companyScope = getScopedCompanyIds(req);

    let events = scopeByCompany(
      normalizeArray(db.securityEvents),
      companyScope
    );

    events.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.json({
      ok: true,
      events: events.slice(0, 100),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   CREATE SECURITY EVENT (NO SPAM)
========================================================= */

router.post("/events", (req, res) => {
  try {
    const { title, description, severity = "low" } = req.body;
    if (!title) return res.status(400).json({ ok: false });

    const db = readDb();
    db.securityEvents = db.securityEvents || [];

    const sev = ["low", "medium", "high", "critical"].includes(
      String(severity).toLowerCase()
    )
      ? severity.toLowerCase()
      : "low";

    const event = {
      id: Date.now().toString(),
      title,
      description: description || "",
      severity: sev,
      acknowledged: false,
      companyId: req.companyId || null,
      createdAt: new Date().toISOString(),
    };

    db.securityEvents.push(event);
    if (db.securityEvents.length > MAX_SECURITY_EVENTS) {
      db.securityEvents = db.securityEvents.slice(-MAX_SECURITY_EVENTS);
    }

    writeDb(db);

    auditQuiet({
      actor: req.user.id,
      role: req.user.role,
      action: "SECURITY_EVENT_CREATED",
      detail: { eventId: event.id },
    });

    return res.status(201).json({ ok: true, event });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   VULNERABILITIES (QUIET)
========================================================= */

router.get("/vulnerabilities", (req, res) => {
  try {
    const db = readDb();
    const companyScope = getScopedCompanyIds(req);

    return res.json({
      ok: true,
      vulnerabilities: scopeByCompany(
        normalizeArray(db.vulnerabilities),
        companyScope
      ),
    });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
