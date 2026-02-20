// backend/src/routes/manager.routes.js
// Manager API — Tenant Scoped • Enterprise Hardened • Admin Override Safe

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { listNotifications } = require("../lib/notify");

const MANAGER = users?.ROLES?.MANAGER || "Manager";
const ADMIN = users?.ROLES?.ADMIN || "Admin";

router.use(authRequired);
router.use(requireRole(MANAGER, { adminAlso: true }));

/* ========================================================= */

function requireTenant(req) {
  if (!req.tenant || !req.tenant.id) {
    const err = new Error("Tenant context required");
    err.status = 403;
    throw err;
  }
}

function safeStr(v, maxLen = 120) {
  const s = String(v || "").trim();
  return s ? s.slice(0, maxLen) : "";
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

/* =========================================================
   PENDING USERS (Scoped)
========================================================= */

router.get("/pending-users", (req, res) => {
  try {
    const db = readDb();
    const isAdmin = req.user.role === ADMIN;

    let list = db.users.filter(
      (u) => u.status === users.APPROVAL_STATUS.PENDING
    );

    if (!isAdmin) {
      requireTenant(req);
      list = list.filter(
        (u) => u.companyId === req.tenant.id
      );
    }

    return res.json({ ok: true, users: list });

  } catch (e) {
    return res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   APPROVE USER (Scoped)
========================================================= */

router.post("/users/:id/approve", (req, res) => {
  try {
    const id = safeStr(req.params.id, 100);
    const db = readDb();
    const isAdmin = req.user.role === ADMIN;

    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error("User not found");

    if (u.role === ADMIN) {
      throw new Error("Managers cannot approve admin accounts");
    }

    if (!isAdmin) {
      requireTenant(req);
      if (u.companyId !== req.tenant.id) {
        throw new Error("Cannot approve outside tenant");
      }
    }

    if (u.status !== users.APPROVAL_STATUS.PENDING) {
      throw new Error("User not eligible");
    }

    u.status = users.APPROVAL_STATUS.MANAGER_APPROVED;
    u.approvedBy = req.user.id;

    writeDb(db);

    return res.json({ ok: true, user: u });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   USERS (Scoped)
========================================================= */

router.get("/users", (req, res) => {
  try {
    const db = readDb();
    const isAdmin = req.user.role === ADMIN;

    let list = db.users;

    if (!isAdmin) {
      requireTenant(req);
      list = list.filter(
        (u) => u.companyId === req.tenant.id
      );
    }

    const sanitized = list.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      companyId: u.companyId || null,
      locked: !!u.locked,
      status: u.status,
    }));

    return res.json({ ok: true, users: sanitized });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   COMPANIES (Scoped)
========================================================= */

router.get("/companies", (req, res) => {
  try {
    const isAdmin = req.user.role === ADMIN;

    if (!isAdmin) {
      requireTenant(req);
      return res.json({
        ok: true,
        companies: [
          companies.getCompany(req.tenant.id),
        ],
      });
    }

    return res.json({
      ok: true,
      companies: companies.listCompanies(),
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   AUDIT (Scoped)
========================================================= */

router.get("/audit", (req, res) => {
  try {
    const db = readDb();
    const isAdmin = req.user.role === ADMIN;
    const limit = clampInt(req.query.limit, 1, 1000, 200);

    let items = db.audit.slice().reverse();

    if (!isAdmin) {
      requireTenant(req);
      items = items.filter(
        (ev) => ev.companyId === req.tenant.id
      );
    }

    return res.json({
      ok: true,
      audit: items.slice(0, limit),
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
