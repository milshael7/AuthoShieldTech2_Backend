// backend/src/routes/company.routes.js
// Enterprise Company Control Layer — Hardened v4
// Subscription Propagation • Seat Enforcement • Lock Cascade • Audit Safe

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

function requireCompanyAccess(req, companyId) {
  if (isAdmin(req.user)) return;

  if (!req.user.companyId)
    throw Object.assign(new Error("No company access"), { status: 403 });

  if (String(req.user.companyId) !== String(companyId))
    throw Object.assign(new Error("Access denied"), { status: 403 });
}

/* =========================================================
   SUBSCRIPTION HELPERS
========================================================= */

function lockCompany(companyId) {
  updateDb((db) => {
    const company = db.companies.find(
      (c) => String(c.id) === String(companyId)
    );
    if (!company) return db;

    company.subscriptionStatus = "Locked";

    // Lock all seat users
    db.users.forEach((u) => {
      if (String(u.companyId) === String(companyId)) {
        u.subscriptionStatus = "Locked";
      }
    });

    // Purge tool grants for this company
    db.toolGrants = (db.toolGrants || []).filter(
      (g) => String(g.companyId) !== String(companyId)
    );

    return db;
  });
}

function propagateTier(companyId, tier) {
  updateDb((db) => {
    const company = db.companies.find(
      (c) => String(c.id) === String(companyId)
    );
    if (!company) return db;

    company.subscriptionTier = tier;

    db.users.forEach((u) => {
      if (String(u.companyId) === String(companyId)) {
        u.subscriptionTier = tier;
      }
    });

    return db;
  });
}

/* =========================================================
   LIST COMPANIES
========================================================= */

router.get("/", (req, res) => {
  try {
    const all = companyService.listCompanies();

    if (isAdmin(req.user))
      return res.json({ ok: true, companies: all });

    if (isManager(req.user)) {
      const managed = all.filter(
        (c) =>
          Array.isArray(c.managers) &&
          c.managers.includes(req.user.id)
      );
      return res.json({ ok: true, companies: managed });
    }

    if (isCompany(req.user)) {
      const own = all.filter(
        (c) => String(c.id) === String(req.user.companyId)
      );
      return res.json({ ok: true, companies: own });
    }

    return res.status(403).json({ ok: false });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADD MEMBER (SUBSCRIPTION ENFORCED)
========================================================= */

router.post("/:id/members", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const db = readDb();
    const company = db.companies.find(
      (c) => String(c.id) === String(req.params.id)
    );

    if (!company)
      return res.status(404).json({ ok: false });

    if (company.subscriptionStatus === "Locked") {
      return res.status(403).json({
        ok: false,
        error: "Company subscription locked",
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
        error: "Seat limit reached",
      });
    }

    const updated = companyService.addMember(
      req.params.id,
      req.body.userId,
      req.user.id,
      req.body.position
    );

    // Propagate tier to new member
    propagateTier(req.params.id, company.subscriptionTier || "free");

    writeAudit({
      actor: req.user.id,
      action: "COMPANY_MEMBER_ADDED",
      detail: { companyId: req.params.id },
    });

    res.json({ ok: true, company: updated });

  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
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
      action: "COMPANY_MEMBER_REMOVED",
      detail: { companyId: req.params.id },
    });

    res.json({ ok: true, company: updated });

  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
