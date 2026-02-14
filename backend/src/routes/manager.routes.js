// backend/src/routes/manager.routes.js
// Manager Room API — Institutional Hardened (Read-Only)
// Admin inherits access

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

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(requireRole(MANAGER, { adminAlso: true }));

/* =========================================================
   HELPERS
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
   OVERVIEW
========================================================= */

// GET /api/manager/overview
router.get("/overview", (req, res) => {
  try {
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
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   USERS (READ-ONLY)
========================================================= */

// GET /api/manager/users
router.get("/users", (req, res) => {
  try {
    return res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   COMPANIES (READ-ONLY)
========================================================= */

// GET /api/manager/companies
router.get("/companies", (req, res) => {
  try {
    return res.json({
      ok: true,
      companies: companies.listCompanies(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

// GET /api/manager/notifications
router.get("/notifications", (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 1000, 200);
    const all = listNotifications({}) || [];

    return res.json({
      ok: true,
      notifications: all.slice(0, limit),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   AUDIT
========================================================= */

// GET /api/manager/audit
router.get("/audit", (req, res) => {
  try {
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
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
