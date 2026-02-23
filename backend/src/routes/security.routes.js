// backend/src/routes/security.routes.js
// Security Tool Control + Dashboard Data Layer
// Subscription Enforced • Company Scoped • Hardened

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
const SUBS = users?.SUBSCRIPTION || {};

const ADMIN_ROLE = ROLES.ADMIN || "Admin";
const COMPANY_ROLE = ROLES.COMPANY || "Company";

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function requireActiveSubscription(dbUser) {
  if (!dbUser) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  if (SUBS.LOCKED && dbUser.subscriptionStatus === SUBS.LOCKED) {
    const err = new Error("Account locked");
    err.status = 403;
    throw err;
  }

  if (SUBS.PAST_DUE && dbUser.subscriptionStatus === SUBS.PAST_DUE) {
    const err = new Error("Subscription past due");
    err.status = 402;
    throw err;
  }
}

function resolveCompanyId(req) {
  const role = normRole(req.user.role);

  if (role === normRole(ADMIN_ROLE)) {
    return clean(req.query.companyId || req.body?.companyId);
  }

  return clean(req.user.companyId);
}

/* =========================================================
   POSTURE SUMMARY (🔥 DASHBOARD FIX)
========================================================= */

router.get("/posture-summary", (req, res) => {
  try {
    const db = readDb();

    const allCompanies = Object.values(db.companies || {});
    const allUsers = Object.values(db.users || {});
    const allIncidents = Object.values(db.incidents || {});
    const allVulns = Object.values(db.vulnerabilities || {});

    const totalCompanies = allCompanies.length;
    const totalUsers = allUsers.length;

    const critical = allVulns.filter(v => v.severity === "critical").length;
    const high = allVulns.filter(v => v.severity === "high").length;
    const medium = allVulns.filter(v => v.severity === "medium").length;
    const low = allVulns.filter(v => v.severity === "low").length;

    const riskScore = Math.max(
      20,
      100 - (critical * 10 + high * 5 + medium * 2)
    );

    const complianceScore = Math.max(
      40,
      100 - (critical * 8 + high * 3)
    );

    return res.json({
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
    return res.status(500).json({
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
    const vulns = Object.values(db.vulnerabilities || {});
    return res.json({ vulnerabilities: vulns });
  } catch {
    return res.status(500).json({ error: "Failed to load vulnerabilities" });
  }
});

/* =========================================================
   EVENTS (Threat Feed)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const db = readDb();
    const limit = Number(req.query.limit) || 50;
    const events = Object.values(db.securityEvents || {})
      .slice(-limit)
      .reverse();

    return res.json({ events });
  } catch {
    return res.status(500).json({ error: "Failed to load events" });
  }
});

/* =========================================================
   TOOL MANAGEMENT (Existing)
========================================================= */

router.get(
  "/tools",
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = resolveCompanyId(req);
      const tools = securityTools.listTools(companyId);

      return res.json({ ok: true, tools });
    } catch (e) {
      return res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/tools/install",
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = resolveCompanyId(req);
      const toolId = clean(req.body?.toolId, 50);

      const result = securityTools.installTool(companyId, toolId, req.user.id);

      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/tools/uninstall",
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = resolveCompanyId(req);
      const toolId = clean(req.body?.toolId, 50);

      const result = securityTools.uninstallTool(companyId, toolId, req.user.id);

      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

module.exports = router;
