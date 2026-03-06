// backend/src/routes/company.routes.js
// =========================================================
// ENTERPRISE COMPANY CONTROL LAYER — HARDENED v6 (SEALED)
// SUBSCRIPTION PROPAGATION • SEAT ENFORCEMENT
// LOCK CASCADE • SESSION REVOCATION • AUDIT SAFE
// QUIET MODE • DETERMINISTIC • PLATFORM-ALIGNED
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const companyService = require("../companies/company.service");
const { updateDb, readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
const users = require("../users/user.service");

/* ================= AUTH ================= */

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function normalize(v) {
  return String(v || "").toLowerCase();
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

  if (!req.user.companyId) {
    const err = new Error("No company access");
    err.status = 403;
    throw err;
  }

  if (!idEq(req.user.companyId, companyId)) {
    const err = new Error("Access denied");
    err.status = 403;
    throw err;
  }
}

/* =========================================================
   SUBSCRIPTION / LOCK HELPERS (ATOMIC)
========================================================= */

function lockCompany(companyId) {
  updateDb((db) => {
    const company = (db.companies || []).find((c) =>
      idEq(c.id, companyId)
    );
    if (!company) return db;

    company.subscriptionStatus = "Locked";
    company.lockedAt = new Date().toISOString();

    (db.users || []).forEach((u) => {
      if (idEq(u.companyId, companyId)) {
        u.subscriptionStatus = "Locked";

        // 🔥 Kill all active sessions for this user
        sessionAdapter.revokeAllUserSessions(u.id);
      }
    });

    // Remove tool grants
    db.toolGrants = (db.toolGrants || []).filter(
      (g) => !idEq(g.companyId, companyId)
    );

    return db;
  });
}

function propagateTier(companyId, tier) {
  updateDb((db) => {
    const company = (db.companies || []).find((c) =>
      idEq(c.id, companyId)
    );
    if (!company) return db;

    company.subscriptionTier = tier;

    (db.users || []).forEach((u) => {
      if (idEq(u.companyId, companyId)) {
        u.subscriptionTier = tier;
      }
    });

    return db;
  });
}

/* =========================================================
   LIST COMPANIES (ROLE-AWARE)
========================================================= */

router.get("/", (req, res) => {
  try {
    const all = companyService.listCompanies();

    if (isAdmin(req.user)) {
      return res.json({ ok: true, companies: all });
    }

    if (isManager(req.user)) {
      const managed = all.filter(
        (c) =>
          Array.isArray(c.managers) &&
          c.managers.includes(req.user.id)
      );
      return res.json({ ok: true, companies: managed });
    }

    if (isCompany(req.user)) {
      const own = all.filter((c) =>
        idEq(c.id, req.user.companyId)
      );
      return res.json({ ok: true, companies: own });
    }

    return res.status(403).json({ ok: false });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   ADD MEMBER (STRICT SEAT ENFORCEMENT)
========================================================= */

router.post("/:id/members", (req, res) => {
  try {
    const companyId = req.params.id;
    requireCompanyAccess(req, companyId);

    const db = readDb();
    const company = (db.companies || []).find((c) =>
      idEq(c.id, companyId)
    );

    if (!company) {
      return res.status(404).json({ ok: false });
    }

    if (company.subscriptionStatus === "Locked") {
      return res.status(403).json({
        ok: false,
        error: "Company subscription locked",
      });
    }

    const seatLimit = Number(company.seatLimit || 0);

    const activeMembers = (db.users || []).filter(
      (u) =>
        idEq(u.companyId, companyId) &&
        u.subscriptionStatus !== "Locked"
    );

    if (
      seatLimit > 0 &&
      activeMembers.length >= seatLimit
    ) {
      return res.status(403).json({
        ok: false,
        error: "Seat limit reached",
      });
    }

    const updated = companyService.addMember(
      companyId,
      req.body.userId,
      req.user.id,
      req.body.position
    );

    propagateTier(
      companyId,
      company.subscriptionTier || "free"
    );

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_MEMBER_ADDED",
      detail: { companyId },
    });

    return res.json({
      ok: true,
      company: updated,
    });
  } catch (e) {
    return res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   REMOVE MEMBER (SESSION KILL)
========================================================= */

router.delete("/:id/members/:userId", (req, res) => {
  try {
    const companyId = req.params.id;
    const userId = req.params.userId;

    requireCompanyAccess(req, companyId);

    const updated = companyService.removeMember(
      companyId,
      userId,
      req.user.id
    );

    // 🔥 Kill all sessions for removed user
    sessionAdapter.revokeAllUserSessions(userId);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_MEMBER_REMOVED",
      detail: { companyId, userId },
    });

    return res.json({
      ok: true,
      company: updated,
    });
  } catch (e) {
    return res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   LOCK COMPANY (ADMIN ONLY, CASCADE)
========================================================= */

router.post("/:id/lock", (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    const companyId = req.params.id;

    lockCompany(companyId);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "COMPANY_LOCKED",
      detail: { companyId },
    });

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to lock company",
    });
  }
});

module.exports = router;
