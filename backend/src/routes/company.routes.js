// backend/src/routes/company.routes.js
// Company Room API — Institutional Hardened
// Scoped Isolation • Admin Override Safe • Production Ready

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

/*
   Resolve company scope safely
*/
function resolveCompanyId(req) {
  const role = normRole(req.user?.role);
  const isAdmin = role === normRole(users.ROLES.ADMIN);

  // Admin override
  if (isAdmin) {
    const fromQuery = safeStr(req.query.companyId, 100);
    const fromBody = safeStr(req.body?.companyId, 100);
    const fromToken = safeStr(req.user.companyId, 100);

    return fromQuery || fromBody || fromToken || null;
  }

  // Company users limited to assigned company
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

/* =========================================================
   COMPANY PROFILE
========================================================= */

// GET /api/company/me
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

      return res.json({
        ok: true,
        company: c,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e?.message || String(e),
      });
    }
  }
);

/* =========================================================
   NOTIFICATIONS
========================================================= */

// GET /api/company/notifications
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
        error: e?.message || String(e),
      });
    }
  }
);

// POST /api/company/notifications/:id/read
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
        error: e?.message || String(e),
      });
    }
  }
);

/* =========================================================
   MEMBER MANAGEMENT
========================================================= */

// POST /api/company/members/add
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

      const result = companies.addMember(
        companyId,
        userId,
        req.user.id
      );

      return res.json({
        ok: true,
        result,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e?.message || String(e),
      });
    }
  }
);

// POST /api/company/members/remove
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
        result,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e?.message || String(e),
      });
    }
  }
);

module.exports = router;
