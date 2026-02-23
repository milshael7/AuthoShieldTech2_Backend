const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { readDb } = require("../lib/db");

router.use(authRequired);

/* =========================================================
   ROLE FALLBACKS
========================================================= */

const ROLES = users?.ROLES || {};
const ADMIN_ROLE = (ROLES.ADMIN || "Admin").toLowerCase();

/* =========================================================
   HELPERS
========================================================= */

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

function isAdmin(role) {
  return String(role || "").toLowerCase() === ADMIN_ROLE;
}

/* =========================================================
   POSTURE SUMMARY (SCOPED + REAL)
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

    // 🔥 ADMIN → global
    if (isAdmin(req.user.role)) {
      scopedCompanies = companiesArr;
      scopedUsers = usersArr;
      scopedVulns = vulnerabilitiesArr;
    } 
    // 🔥 COMPANY → only their company
    else {
      const companyId = req.user.companyId;

      scopedCompanies = companiesArr.filter(
        (c) => c.id === companyId
      );

      scopedUsers = usersArr.filter(
        (u) => u.companyId === companyId
      );

      scopedVulns = vulnerabilitiesArr.filter(
        (v) => v.companyId === companyId
      );
    }

    const totalCompanies = scopedCompanies.length;
    const totalUsers = scopedUsers.length;

    const critical = scopedVulns.filter(
      (v) => v.severity === "critical"
    ).length;

    const high = scopedVulns.filter(
      (v) => v.severity === "high"
    ).length;

    const medium = scopedVulns.filter(
      (v) => v.severity === "medium"
    ).length;

    const low = scopedVulns.filter(
      (v) => v.severity === "low"
    ).length;

    // 🔥 Risk Calculation (real weight model)
    let riskScore =
      100 -
      (critical * 15 +
        high * 8 +
        medium * 4 +
        low * 1);

    if (riskScore < 5) riskScore = 5;
    if (riskScore > 100) riskScore = 100;

    // 🔥 Compliance Calculation
    let complianceScore =
      100 -
      (critical * 10 +
        high * 6 +
        medium * 3);

    if (complianceScore < 10) complianceScore = 10;
    if (complianceScore > 100) complianceScore = 100;

    res.json({
      ok: true,
      scope: isAdmin(req.user.role) ? "global" : "company",
      totalCompanies,
      totalUsers,
      incidents: incidentsArr.length,
      riskScore: Math.round(riskScore),
      complianceScore: Math.round(complianceScore),
      critical,
      high,
      medium,
      low,
      timestamp: Date.now(),
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Failed to generate posture summary",
    });
  }
});

/* =========================================================
   VULNERABILITIES (SCOPED)
========================================================= */

router.get("/vulnerabilities", (req, res) => {
  try {
    const db = readDb();
    const vulnerabilitiesArr = normalizeArray(db.vulnerabilities);

    if (isAdmin(req.user.role)) {
      return res.json({ ok: true, vulnerabilities: vulnerabilitiesArr });
    }

    const filtered = vulnerabilitiesArr.filter(
      (v) => v.companyId === req.user.companyId
    );

    res.json({ ok: true, vulnerabilities: filtered });

  } catch {
    res.status(500).json({
      ok: false,
      error: "Failed to load vulnerabilities",
    });
  }
});

/* =========================================================
   SECURITY EVENTS (SCOPED)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const limit = Number(req.query.limit) || 50;

    const eventsArr = normalizeArray(db.securityEvents);

    let filtered = eventsArr;

    if (!isAdmin(req.user.role)) {
      filtered = eventsArr.filter(
        (e) => e.companyId === req.user.companyId
      );
    }

    const events = filtered
      .slice(-limit)
      .reverse();

    res.json({ ok: true, events });

  } catch {
    res.status(500).json({
      ok: false,
      error: "Failed to load events",
    });
  }
});

/* =========================================================
   TOOL ROUTES (UNCHANGED)
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
