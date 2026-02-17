// backend/src/routes/manager.routes.js
// Manager Room API — Institutional Hardened (Read-Only)
// Admin inherits access
// Explicit privilege boundaries enforced

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb } = require("../lib/db");

const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { listNotifications } = require("../lib/notify");

/* =========================================================
   ROLE SAFETY
========================================================= */

const MANAGER = users?.ROLES?.MANAGER || "Manager";
const ADMIN = users?.ROLES?.ADMIN || "Admin";

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(requireRole(MANAGER, { adminAlso: true }));

/* =========================================================
   SECURITY HELPERS
========================================================= */

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function safeStr(v, maxLen = 120) {
  const s = String(v || "").trim();
  return s ? s.slice(0, maxLen) : "";
}

/* =========================================================
   ACCESS ENFORCEMENT
========================================================= */

// Manager cannot override admin
function ensureNotAdminTarget(targetRole) {
  if (String(targetRole || "").toLowerCase() === "admin") {
    const err = new Error("Managers cannot act on admin accounts");
    err.status = 403;
    throw err;
  }
}

// Prevent suspended manager usage
function ensureManagerActive(req) {
  if (req.user?.suspended) {
    const err = new Error("Manager account suspended");
    err.status = 403;
    throw err;
  }
}

/* =========================================================
   OVERVIEW
========================================================= */

// GET /api/manager/overview
router.get("/overview", (req, res) => {
  try {
    ensureManagerActive(req);

    const db = readDb();

    return res.json({
      ok: true,
      overview: {
        users: db.users?.length || 0,
        companies: db.companies?.length || 0,
        auditEvents: db.audit?.length || 0,
        notifications: db.notifications?.length || 0,
      },
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   USERS (READ-ONLY)
========================================================= */

router.get("/users", (req, res) => {
  try {
    ensureManagerActive(req);

    const allUsers = users.listUsers() || [];

    // Manager cannot inspect internal admin secrets
    const sanitized = allUsers.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      companyId: u.companyId || null,
      suspended: !!u.suspended,
      mfa: !!u.mfa
    }));

    return res.json({
      ok: true,
      users: sanitized,
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   COMPANIES (READ-ONLY)
========================================================= */

router.get("/companies", (req, res) => {
  try {
    ensureManagerActive(req);

    const list = companies.listCompanies() || [];

    const sanitized = list.map(c => ({
      id: c.id,
      name: c.name,
      suspended: !!c.suspended,
      sizeTier: c.sizeTier || "standard",
      createdAt: c.createdAt || null,
    }));

    return res.json({
      ok: true,
      companies: sanitized,
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    ensureManagerActive(req);

    const limit = clampInt(req.query.limit, 1, 1000, 200);
    const all = listNotifications({}) || [];

    return res.json({
      ok: true,
      notifications: all.slice(0, limit),
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   AUDIT
========================================================= */

router.get("/audit", (req, res) => {
  try {
    ensureManagerActive(req);

    const db = readDb();
    const limit = clampInt(req.query.limit, 1, 1000, 200);

    const actorId = safeStr(req.query.actorId);
    const actionQ = safeStr(req.query.action).toLowerCase();

    let items = (db.audit || []).slice().reverse();

    if (actorId) {
      items = items.filter(
        (ev) => String(ev.actorId || "") === actorId
      );
    }

    if (actionQ) {
      items = items.filter((ev) =>
        String(ev.action || "")
          .toLowerCase()
          .includes(actionQ)
      );
    }

    return res.json({
      ok: true,
      audit: items.slice(0, limit),
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
