// backend/src/routes/company.routes.js
// Company Routes — Enterprise Hardened + Admin Intelligence Layer

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const companyService = require("../companies/company.service");
const { updateDb, readDb } = require("../lib/db");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function requireCompanyAccess(req, companyId) {
  const isAdmin = req.user.role === "Admin";
  if (isAdmin) return;

  if (!req.user.companyId) {
    const err = new Error("No company access");
    err.status = 403;
    throw err;
  }

  if (String(req.user.companyId) !== String(companyId)) {
    const err = new Error("Access denied to this company");
    err.status = 403;
    throw err;
  }
}

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

/* =========================================================
   CREATE COMPANY (ADMIN ONLY)
========================================================= */

router.post("/", requireRole("Admin"), (req, res) => {
  try {
    const company = companyService.createCompany({
      ...req.body,
      createdBy: req.user.id,
    });

    res.status(201).json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   LIST COMPANIES
========================================================= */

router.get("/", requireRole("Admin", "Manager", "Company", { adminAlso: true }), (req, res) => {
  try {
    const all = companyService.listCompanies();

    if (req.user.role === "Company") {
      const own = all.filter(
        (c) => String(c.id) === String(req.user.companyId)
      );
      return res.json({ ok: true, companies: own });
    }

    res.json({ ok: true, companies: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 NEW — COMPANY OPERATIONAL OVERVIEW (ADMIN CONTROL)
========================================================= */

router.get("/:id/overview", requireRole("Admin", "Company", { adminAlso: true }), (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const db = readDb();
    const companies = normalizeArray(db.companies);
    const users = normalizeArray(db.users);
    const vulnerabilities = normalizeArray(db.vulnerabilities);
    const incidents = normalizeArray(db.incidents);
    const autoprotek = db.autoprotek?.users || {};

    const company = companies.find(
      (c) => String(c.id) === String(req.params.id)
    );

    if (!company) {
      return res.status(404).json({
        ok: false,
        error: "Company not found",
      });
    }

    const members = users.filter(
      (u) => String(u.companyId) === String(req.params.id)
    );

    const vulns = vulnerabilities.filter(
      (v) => String(v.companyId) === String(req.params.id)
    );

    const companyIncidents = incidents.filter(
      (i) => String(i.companyId) === String(req.params.id)
    );

    const critical = vulns.filter(v => v.severity === "critical").length;
    const high = vulns.filter(v => v.severity === "high").length;
    const medium = vulns.filter(v => v.severity === "medium").length;
    const low = vulns.filter(v => v.severity === "low").length;

    let riskScore =
      100 - (critical * 15 + high * 8 + medium * 4);

    if (riskScore < 5) riskScore = 5;
    if (riskScore > 100) riskScore = 100;

    const autoprotekEnabled =
      members.some((m) => autoprotek[m.id]);

    res.json({
      ok: true,
      overview: {
        company,
        memberCount: members.length,
        incidentCount: companyIncidents.length,
        vulnerabilityCounts: {
          critical,
          high,
          medium,
          low,
        },
        riskScore: Math.round(riskScore),
        autoprotekEnabled,
        lastUpdated: Date.now(),
      },
    });

  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   MEMBER MANAGEMENT
========================================================= */

router.post("/:id/members", requireRole("Admin", "Company", { adminAlso: true }), (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const company = companyService.addMember(
      req.params.id,
      req.body.userId,
      req.user.id,
      req.body.position
    );

    res.json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

router.delete("/:id/members/:userId", requireRole("Admin", "Company", { adminAlso: true }), (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const company = companyService.removeMember(
      req.params.id,
      req.params.userId,
      req.user.id
    );

    res.json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   AUTOPROTECT ROUTES (UNCHANGED CORE LOGIC)
========================================================= */

router.post("/:id/autoprotect/email", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const { email } = req.body;

    updateDb((db) => {
      db.autoprotek = db.autoprotek || { users: {} };
      db.autoprotek.users = db.autoprotek.users || {};
      const userId = req.user.id;

      if (!db.autoprotek.users[userId]) {
        db.autoprotek.users[userId] = { companies: {} };
      }

      db.autoprotek.users[userId].companies =
        db.autoprotek.users[userId].companies || {};

      db.autoprotek.users[userId].companies[req.params.id] = {
        email: clean(email, 200),
      };
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
