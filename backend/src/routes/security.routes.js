const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const securityTools = require("../services/securityTools");
const { readDb, writeDb } = require("../lib/db");

router.use(authRequired);

/* =========================================================
   ROLE FALLBACKS
========================================================= */

const ROLES = users?.ROLES || {};
const ADMIN_ROLE = (ROLES.ADMIN || "Admin").toLowerCase();

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

function isAdmin(role) {
  return String(role || "").toLowerCase() === ADMIN_ROLE;
}

/* =========================================================
   POSTURE SUMMARY
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const db = readDb();

    const companiesArr = normalizeArray(db.companies);
    const usersArr = normalizeArray(db.users);
    const vulnerabilitiesArr = normalizeArray(db.vulnerabilities);
    const incidentsArr = normalizeArray(db.incidents);

    let scopedCompanies = [];
    let scopedUsers = [];
    let scopedVulns = [];

    if (isAdmin(req.user.role)) {
      scopedCompanies = companiesArr;
      scopedUsers = usersArr;
      scopedVulns = vulnerabilitiesArr;
    } else {
      const companyId = req.user.companyId;

      scopedCompanies = companiesArr.filter(c => c.id === companyId);
      scopedUsers = usersArr.filter(u => u.companyId === companyId);
      scopedVulns = vulnerabilitiesArr.filter(v => v.companyId === companyId);
    }

    const critical = scopedVulns.filter(v => v.severity === "critical").length;
    const high = scopedVulns.filter(v => v.severity === "high").length;
    const medium = scopedVulns.filter(v => v.severity === "medium").length;
    const low = scopedVulns.filter(v => v.severity === "low").length;

    let riskScore = 100 - (critical * 15 + high * 8 + medium * 4 + low * 1);
    if (riskScore < 5) riskScore = 5;
    if (riskScore > 100) riskScore = 100;

    let complianceScore = 100 - (critical * 10 + high * 6 + medium * 3);
    if (complianceScore < 10) complianceScore = 10;
    if (complianceScore > 100) complianceScore = 100;

    res.json({
      ok: true,
      scope: isAdmin(req.user.role) ? "global" : "company",
      totalCompanies: scopedCompanies.length,
      totalUsers: scopedUsers.length,
      incidents: incidentsArr.length,
      riskScore: Math.round(riskScore),
      complianceScore: Math.round(complianceScore),
      critical,
      high,
      medium,
      low,
      timestamp: Date.now(),
    });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to generate posture summary" });
  }
});

/* =========================================================
   VULNERABILITIES
========================================================= */

router.get("/vulnerabilities", (req, res) => {
  try {
    const db = readDb();
    const vulnerabilitiesArr = normalizeArray(db.vulnerabilities);

    if (isAdmin(req.user.role)) {
      return res.json({ ok: true, vulnerabilities: vulnerabilitiesArr });
    }

    const filtered = vulnerabilitiesArr.filter(
      v => v.companyId === req.user.companyId
    );

    res.json({ ok: true, vulnerabilities: filtered });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to load vulnerabilities" });
  }
});

/* =========================================================
   SECURITY EVENTS (NOW WITH ACK SUPPORT)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const limit = Number(req.query.limit) || 50;

    let eventsArr = normalizeArray(db.securityEvents);

    if (!isAdmin(req.user.role)) {
      eventsArr = eventsArr.filter(
        e => e.companyId === req.user.companyId
      );
    }

    const events = eventsArr
      .slice(-limit)
      .reverse();

    res.json({ ok: true, events });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to load events" });
  }
});

/* =========================================================
   ACKNOWLEDGE EVENT
========================================================= */

router.patch("/events/:id/ack", (req, res) => {
  try {
    const db = readDb();
    const { id } = req.params;

    const event = db.securityEvents.find(e => e.id === id);

    if (!event) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    if (!isAdmin(req.user.role) &&
        event.companyId !== req.user.companyId) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    event.acknowledged = true;
    event.acknowledgedBy = req.user.id;
    event.acknowledgedAt = Date.now();

    writeDb(db);

    res.json({ ok: true, event });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to acknowledge event" });
  }
});

/* =========================================================
   TOOL ROUTES
========================================================= */

router.get(
  "/tools",
  requireRole("Company", { adminAlso: true }),
  (req, res) => {
    try {
      const tools = securityTools.listTools(req.user.companyId);
      res.json({ ok: true, tools });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

router.post(
  "/tools/install",
  requireRole("Company", { adminAlso: true }),
  (req, res) => {
    try {
      const result = securityTools.installTool(
        req.user.companyId,
        req.body.toolId,
        req.user.id
      );
      res.json({ ok: true, result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

router.post(
  "/tools/uninstall",
  requireRole("Company", { adminAlso: true }),
  (req, res) => {
    try {
      const result = securityTools.uninstallTool(
        req.user.companyId,
        req.body.toolId,
        req.user.id
      );
      res.json({ ok: true, result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

module.exports = router;
