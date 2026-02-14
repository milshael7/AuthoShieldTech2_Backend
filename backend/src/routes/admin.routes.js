// backend/src/routes/admin.routes.js
// Admin API — Institutional Hardened Version

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

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function safeLimit(v, max = 1000, fallback = 200) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/* =========================================================
   USERS
========================================================= */

// GET /api/admin/users
router.get("/users", (req, res) => {
  try {
    return res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users
router.post("/users", (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      email: cleanStr(body.email, 200),
      role: cleanStr(body.role, 50),
      companyId:
        typeof body.companyId === "string"
          ? cleanStr(body.companyId, 100) || null
          : null,
      password: body.password,
    };

    const created = users.createUser(payload);

    return res.status(201).json({
      ok: true,
      user: created,
    });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users/:id/rotate-id
router.post("/users/:id/rotate-id", (req, res) => {
  try {
    const result =
      users.rotatePlatformIdAndForceReset(
        req.params.id,
        req.user.id
      );

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users/:id/subscription
router.post("/users/:id/subscription", (req, res) => {
  try {
    const patch = {};
    const body = req.body || {};

    if (typeof body.subscriptionStatus === "string") {
      patch.subscriptionStatus = cleanStr(
        body.subscriptionStatus,
        50
      );
    }

    if (typeof body.autoprotectEnabled !== "undefined") {
      const enabled = !!body.autoprotectEnabled;
      patch.autoprotectEnabled = enabled;
      patch.autoprotechEnabled = enabled; // legacy support
    }

    const updated =
      users.updateUser(
        req.params.id,
        patch,
        req.user.id
      );

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

/* =========================================================
   COMPANIES
========================================================= */

// GET /api/admin/companies
router.get("/companies", (req, res) => {
  try {
    return res.json({
      ok: true,
      companies: companies.listCompanies(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/companies
router.post("/companies", (req, res) => {
  try {
    const body = req.body || {};

    const created = companies.createCompany({
      name: cleanStr(body.name, 200),
      createdBy: req.user.id,
    });

    return res.status(201).json({
      ok: true,
      company: created,
    });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

// GET /api/admin/notifications
router.get("/notifications", (req, res) => {
  try {
    return res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/* =========================================================
   MANAGER MIRROR
========================================================= */

// GET /api/admin/manager/overview
router.get("/manager/overview", (req, res) => {
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
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/admin/manager/audit
router.get("/manager/audit", (req, res) => {
  try {
    const db = readDb();
    const limit = safeLimit(req.query.limit);

    return res.json({
      ok: true,
      audit: (db.audit || [])
        .slice(-limit)
        .reverse(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/admin/manager/notifications
router.get("/manager/notifications", (req, res) => {
  try {
    return res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
