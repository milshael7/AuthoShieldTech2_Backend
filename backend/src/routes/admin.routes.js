// backend/src/routes/admin.routes.js
// Admin API — Supreme Authority Version (Phase 4)

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");

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

function audit(action, actorId, targetId, meta = {}) {
  const db = readDb();
  db.audit = db.audit || [];

  db.audit.push({
    id: Date.now().toString(),
    at: new Date().toISOString(),
    action,
    actorId,
    targetId,
    meta,
  });

  writeDb(db);
}

/* =========================================================
   USERS
========================================================= */

// GET USERS
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

// SUSPEND USER
router.post("/users/:id/suspend", (req, res) => {
  try {
    const updated = users.updateUser(req.params.id, {
      locked: true,
    }, req.user.id);

    audit("ADMIN_SUSPEND_USER", req.user.id, req.params.id);

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// REACTIVATE USER
router.post("/users/:id/reactivate", (req, res) => {
  try {
    const updated = users.updateUser(req.params.id, {
      locked: false,
    }, req.user.id);

    audit("ADMIN_REACTIVATE_USER", req.user.id, req.params.id);

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// CHANGE USER ROLE
router.post("/users/:id/role", (req, res) => {
  try {
    const role = cleanStr(req.body.role, 50);

    const updated = users.updateUser(req.params.id, {
      role,
    }, req.user.id);

    audit("ADMIN_CHANGE_ROLE", req.user.id, req.params.id, { role });

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

/* =========================================================
   COMPANIES
========================================================= */

// LIST COMPANIES
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

// SUSPEND COMPANY
router.post("/companies/:id/suspend", (req, res) => {
  try {
    const updated = companies.updateCompany(req.params.id, {
      suspended: true,
    });

    audit("ADMIN_SUSPEND_COMPANY", req.user.id, req.params.id);

    return res.json({ ok: true, company: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
