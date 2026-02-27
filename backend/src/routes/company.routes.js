// backend/src/routes/company.routes.js
// Enterprise Company Control Layer — Hardened v5
// Subscription Propagation • Seat Enforcement • Lock Cascade • Session Kill • Audit Safe

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const companyService = require("../companies/company.service");
const { updateDb, readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
const users = require("../users/user.service");

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").toLowerCase();
}

function idEq(a, b) {
  return String(a) === String(b);
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

  if (!idEq(req.user.companyId, companyId))
    throw Object.assign(new Error("Access denied"), { status: 403 });
}

/* =========================================================
   SUBSCRIPTION HELPERS
========================================================= */

function lockCompany(companyId) {
  updateDb((db) => {
    const company = db.companies.find((c) => idEq(c.id, companyId));
    if (!company) return db;

    company.subscriptionStatus = "Locked";

    db.users.forEach((u) => {
      if (idEq(u.companyId, companyId)) {
        u.subscriptionStatus = "Locked";

        // 🔥 Kill active sessions
        sessionAdapter.revokeAllUserSessions(u.id);
      }
    });

    db.toolGrants = (db.toolGrants || []).filter(
      (g) => !idEq(g.companyId, companyId)
    );

    return db;
  });
}

function propagateTier(companyId, tier) {
  updateDb((db) => {
    const company = db.companies.find((c) => idEq(c.id, companyId));
    if (!company) return db;

    company.subscriptionTier = tier;

    db.users.forEach((u) => {
      if (idEq(u.companyId, companyId)) {
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
        (c) => idEq(c.id, req.user.companyId)
      );
      return res.json({ ok: true, companies: own });
    }

    return res.status(403).json({ ok: false });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   ADD MEMBER (STRICT SEAT ENFORCEMENT)
========================================================= */

router.post("/:id/members", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const db = readDb();
    const company = db.companies.find(
      (c) => idEq(c.id, req.params.id)
    );

    if (!company)
      return res.status(404).json({ ok: false });

    if (company.subscriptionStatus === "Locked") {
      return res.status(403).json({
        ok: false,
        error: "Company subscription locked",
      });
    }

    const seatLimit = Number(company.seatLimit || 0);

    const activeMembers = db.users.filter(
      (u) =>
        idEq(u.companyId, req.params.id) &&
        u.subscriptionStatus !== "Locked"
    );

    if (seatLimit > 0 && activeMembers.length >= seatLimit) {
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

    // Kill removed user's sessions
    sessionAdapter.revokeAllUserSessions(req.params.userId);

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
