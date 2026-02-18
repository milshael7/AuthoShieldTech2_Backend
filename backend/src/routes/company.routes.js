// backend/src/routes/company.routes.js
// Company Room API — Tier Controlled • Plan Enforced • Secure

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { listNotifications, markRead } = require("../lib/notify");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function safeStr(v, max = 120) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : "";
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

/* =========================================================
   COMPANY CONTEXT
========================================================= */

function resolveCompanyId(req) {
  const role = normRole(req.user?.role);
  const isAdmin = role === normRole(users.ROLES.ADMIN);

  if (isAdmin) {
    const fromQuery = safeStr(req.query.companyId, 100);
    const fromBody = safeStr(req.body?.companyId, 100);
    const fromToken = safeStr(req.user.companyId, 100);
    return fromQuery || fromBody || fromToken || null;
  }

  return safeStr(req.user.companyId, 100) || null;
}

function requireCompany(req, res) {
  const companyId = resolveCompanyId(req);

  if (!companyId) {
    res.status(400).json({
      ok: false,
      error: "Company context missing",
    });
    return null;
  }

  return companyId;
}

function ensureCompanyActive(company) {
  if (!company || company.status !== "Active") {
    const err = new Error("Company not active");
    err.status = 403;
    throw err;
  }
}

/* =========================================================
   COMPANY PROFILE
========================================================= */

router.get(
  "/me",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const c = companies.getCompany(companyId);
      if (!c) {
        return res.status(404).json({
          ok: false,
          error: "Company not found",
        });
      }

      ensureCompanyActive(c);

      return res.json({
        ok: true,
        company: {
          id: c.id,
          name: c.name,
          tier: c.tier,
          maxUsers: c.maxUsers,
          currentUsers: Array.isArray(c.members)
            ? c.members.length
            : 0,
          members: c.members || [],
          createdAt: c.createdAt || null,
        },
      });
    } catch (e) {
      return res.status(e.status || 500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   UPGRADE PLAN
========================================================= */

router.post(
  "/upgrade",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const newTier = safeStr(req.body?.tier, 30);
      if (!newTier) {
        return res.status(400).json({
          ok: false,
          error: "Missing tier",
        });
      }

      const updated = companies.upgradeCompany(
        companyId,
        newTier,
        req.user.id
      );

      return res.json({
        ok: true,
        company: {
          id: updated.id,
          tier: updated.tier,
          maxUsers: updated.maxUsers,
        },
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   MEMBER MANAGEMENT
========================================================= */

router.post(
  "/members/add",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const userId = safeStr(req.body?.userId, 100);
      if (!userId) {
        return res.status(400).json({
          ok: false,
          error: "Missing userId",
        });
      }

      const targetUser = users.findById(userId);
      if (!targetUser) {
        return res.status(404).json({
          ok: false,
          error: "User not found",
        });
      }

      if (
        normRole(targetUser.role) === normRole(users.ROLES.ADMIN) ||
        normRole(targetUser.role) === normRole(users.ROLES.MANAGER)
      ) {
        return res.status(403).json({
          ok: false,
          error: "Cannot assign admin or manager to company",
        });
      }

      const result = companies.addMember(
        companyId,
        userId,
        req.user.id
      );

      return res.json({
        ok: true,
        company: result,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/members/remove",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const userId = safeStr(req.body?.userId, 100);
      if (!userId) {
        return res.status(400).json({
          ok: false,
          error: "Missing userId",
        });
      }

      const result = companies.removeMember(
        companyId,
        userId,
        req.user.id
      );

      return res.json({
        ok: true,
        company: result,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get(
  "/notifications",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      return res.json({
        ok: true,
        notifications: listNotifications({ companyId }) || [],
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/notifications/:id/read",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const id = safeStr(req.params.id, 100);
      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "Missing notification id",
        });
      }

      const n = markRead(id, null, companyId);

      if (!n) {
        return res.status(404).json({
          ok: false,
          error: "Notification not found",
        });
      }

      return res.json({
        ok: true,
        notification: n,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

module.exports = router;
