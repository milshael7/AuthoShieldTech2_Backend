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
const ADMIN_ROLE = ROLES.ADMIN || "Admin";

/* =========================================================
   POSTURE SUMMARY (DASHBOARD CORE)
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const db = readDb();

    const companiesArr = db.companies
      ? Array.isArray(db.companies)
        ? db.companies
        : Object.values(db.companies)
      : [];

    const usersArr = db.users
      ? Array.isArray(db.users)
        ? db.users
        : Object.values(db.users)
      : [];

    const incidentsArr = db.incidents || [];
    const vulnerabilitiesArr = db.vulnerabilities || [];

    const totalCompanies = companiesArr.length;
    const totalUsers = usersArr.length;

    const critical = vulnerabilitiesArr.filter(v => v.severity === "critical").length;
    const high = vulnerabilitiesArr.filter(v => v.severity === "high").length;
    const medium = vulnerabilitiesArr.filter(v => v.severity === "medium").length;
    const low = vulnerabilitiesArr.filter(v => v.severity === "low").length;

    const riskScore = Math.max(
      25,
      100 - (critical * 12 + high * 6 + medium * 3)
    );

    const complianceScore = Math.max(
      40,
      100 - (critical * 8 + high * 4)
    );

    res.json({
      totalCompanies,
      totalUsers,
      riskScore,
      complianceScore,
      critical,
      high,
      medium,
      low,
    });

  } catch (err) {
    res.status(500).json({
      error: "Failed to generate posture summary",
    });
  }
});

/* =========================================================
   VULNERABILITIES
========================================================= */

router.get("/vulnerabilities", (req, res) => {
  try {
    const db = readDb();
    res.json({
      vulnerabilities: db.vulnerabilities || [],
    });
  } catch {
    res.status(500).json({
      error: "Failed to load vulnerabilities",
    });
  }
});

/* =========================================================
   SECURITY EVENTS (Threat Feed)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const limit = Number(req.query.limit) || 50;

    const events = (db.securityEvents || [])
      .slice(-limit)
      .reverse();

    res.json({ events });

  } catch {
    res.status(500).json({
      error: "Failed to load events",
    });
  }
});

/* =========================================================
   EXISTING TOOL ROUTES (UNCHANGED)
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
