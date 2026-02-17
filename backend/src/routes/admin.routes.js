// backend/src/routes/admin.routes.js
// Admin API — Supreme Authority Version (Phase 5 Hardened)

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

function requireId(id) {
  const clean = cleanStr(id, 100);
  if (!clean) throw new Error("Invalid id");
  return clean;
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

function ensureNotSelfAction(req, targetId) {
  if (req.user.id === targetId) {
    throw new Error("Admin cannot perform this action on themselves");
  }
}

function ensureNotLastAdmin(targetUser) {
  const db = readDb();
  const admins = (db.users || []).filter(
    (u) => u.role === ADMIN_ROLE && !u.locked
  );

  if (admins.length <= 1 && targetUser.role === ADMIN_ROLE) {
    throw new Error("Cannot modify the last active admin");
  }
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
    const id = requireId(req.params.id);
    ensureNotSelfAction(req, id);

    const target = users.listUsers().find((u) => u.id === id);
    if (!target) throw new Error("User not found");

    ensureNotLastAdmin(target);

    const updated = users.updateUser(
      id,
      { locked: true },
      req.user.id
    );

    audit("ADMIN_SUSPEND_USER", req.user.id, id);

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// REACTIVATE USER
router.post("/users/:id/reactivate", (req, res) => {
  try {
    const id = requireId(req.params.id);

    const updated = users.updateUser(
      id,
      { locked: false },
      req.user.id
    );

    audit("ADMIN_REACTIVATE_USER", req.user.id, id);

    return res.json({ ok: true, user: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// CHANGE USER ROLE
router.post("/users/:id/role", (req, res) => {
  try {
    const id = requireId(req.params.id);
    ensureNotSelfAction(req, id);

    const role = cleanStr(req.body.role, 50);
    if (!Object.values(users.ROLES).includes(role)) {
      throw new Error("Invalid role");
    }

    const target = users.listUsers().find((u) => u.id === id);
    if (!target) throw new Error("User not found");

    ensureNotLastAdmin(target);

    const updated = users.updateUser(
      id,
      { role },
      req.user.id
    );

    audit("ADMIN_CHANGE_ROLE", req.user.id, id, { role });

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

// CREATE COMPANY
router.post("/companies", (req, res) => {
  try {
    const name = cleanStr(req.body?.name, 200);
    if (!name) throw new Error("Company name required");

    const created = companies.createCompany({
      name,
      createdBy: req.user.id,
    });

    audit("ADMIN_CREATE_COMPANY", req.user.id, created.id);

    return res.status(201).json({
      ok: true,
      company: created,
    });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// SUSPEND COMPANY
router.post("/companies/:id/suspend", (req, res) => {
  try {
    const id = requireId(req.params.id);

    const updated = companies.updateCompany(id, {
      suspended: true,
    });

    audit("ADMIN_SUSPEND_COMPANY", req.user.id, id);

    return res.json({ ok: true, company: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// REACTIVATE COMPANY
router.post("/companies/:id/reactivate", (req, res) => {
  try {
    const id = requireId(req.params.id);

    const updated = companies.updateCompany(id, {
      suspended: false,
    });

    audit("ADMIN_REACTIVATE_COMPANY", req.user.id, id);

    return res.json({ ok: true, company: updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

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
   MANAGER MIRROR (Admin sees everything)
========================================================= */

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

router.get("/manager/audit", (req, res) => {
  try {
    const db = readDb();
    const limit = safeLimit(req.query.limit);

    return res.json({
      ok: true,
      audit: (db.audit || []).slice(-limit).reverse(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

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
