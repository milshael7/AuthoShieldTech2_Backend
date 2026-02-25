// backend/src/routes/company.routes.js
// Enterprise Company Control Layer — Hardened v3
// Admin + Manager Scoped • Seat Enforced • Tier Ready • Audit Safe

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const companyService = require("../companies/company.service");
const { updateDb, readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").toLowerCase();
}

function isAdmin(user) {
  return normalize(user.role) === normalize(users.ROLES.ADMIN);
}

function isManager(user) {
  return normalize(user.role) === normalize(users.ROLES.MANAGER);
}

function isCompany(user) {
  return normalize(user.role) === normalize(users.ROLES.COMPANY);
}

/* =========================================================
   COMPANY ACCESS GUARD
========================================================= */

function requireCompanyAccess(req, companyId) {
  if (isAdmin(req.user)) return;

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

/* =========================================================
   CREATE COMPANY (ADMIN ONLY)
========================================================= */

router.post("/", (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only"
      });
    }

    const company = companyService.createCompany({
      ...req.body,
      createdBy: req.user.id,
    });

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_CREATED",
      detail: { companyId: company.id }
    });

    res.status(201).json({ ok: true, company });

  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   LIST COMPANIES
========================================================= */

router.get("/", (req, res) => {
  try {
    const all = companyService.listCompanies();

    // Admin sees all
    if (isAdmin(req.user)) {
      return res.json({ ok: true, companies: all });
    }

    // Manager sees companies they manage
    if (isManager(req.user)) {
      const managed = all.filter(c =>
        Array.isArray(c.managers) &&
        c.managers.includes(req.user.id)
      );
      return res.json({ ok: true, companies: managed });
    }

    // Company role sees only itself
    if (isCompany(req.user)) {
      const own = all.filter(
        (c) => String(c.id) === String(req.user.companyId)
      );
      return res.json({ ok: true, companies: own });
    }

    return res.status(403).json({
      ok: false,
      error: "Forbidden"
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   COMPANY OPERATIONAL OVERVIEW
========================================================= */

router.get("/:id/overview", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const db = readDb();
    const companies = db.companies || [];
    const usersArr = db.users || [];
    const vulnerabilities = db.vulnerabilities || [];
    const incidents = db.incidents || [];

    const company = companies.find(
      (c) => String(c.id) === String(req.params.id)
    );

    if (!company) {
      return res.status(404).json({
        ok: false,
        error: "Company not found",
      });
    }

    const members = usersArr.filter(
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

    riskScore = Math.max(5, Math.min(100, riskScore));

    res.json({
      ok: true,
      overview: {
        company,
        tier: company.tier || "standard",
        seatLimit: company.seatLimit || null,
        memberCount: members.length,
        incidentCount: companyIncidents.length,
        vulnerabilityCounts: { critical, high, medium, low },
        riskScore: Math.round(riskScore),
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
   ADD MEMBER (SEAT ENFORCED)
========================================================= */

router.post("/:id/members", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const db = readDb();
    const company = db.companies.find(
      (c) => String(c.id) === String(req.params.id)
    );

    if (!company) {
      return res.status(404).json({
        ok: false,
        error: "Company not found"
      });
    }

    const currentMembers = db.users.filter(
      (u) => String(u.companyId) === String(req.params.id)
    );

    if (
      company.seatLimit &&
      currentMembers.length >= company.seatLimit
    ) {
      return res.status(403).json({
        ok: false,
        error: "Seat limit reached"
      });
    }

    const updated = companyService.addMember(
      req.params.id,
      req.body.userId,
      req.user.id,
      req.body.position
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_MEMBER_ADDED",
      detail: { companyId: req.params.id }
    });

    res.json({ ok: true, company: updated });

  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REMOVE MEMBER
========================================================= */

router.delete("/:id/members/:userId", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const updated = companyService.removeMember(
      req.params.id,
      req.params.userId,
      req.user.id
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_MEMBER_REMOVED",
      detail: { companyId: req.params.id }
    });

    res.json({ ok: true, company: updated });

  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   AUTOPROTECT EMAIL CONFIG
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
        email: String(email || "").trim().slice(0, 200),
      };
    });

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "AUTOPROTECT_EMAIL_UPDATED",
      detail: { companyId: req.params.id }
    });

    res.json({ ok: true });

  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
