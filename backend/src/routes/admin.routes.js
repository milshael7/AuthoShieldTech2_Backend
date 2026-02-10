// backend/src/routes/admin.routes.js
// Admin API — full control (users, companies, notifications)
// ✅ Stable, safe, complete

const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');

const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

// ---------------- Role safety ----------------
const ADMIN_ROLE = users?.ROLES?.ADMIN || 'Admin';

// ---------------- Middleware ----------------
router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

// ---------------- Helpers ----------------
function cleanStr(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

// ---------------- Users ----------------

// GET /api/admin/users
router.get('/users', (req, res) => {
  try {
    return res.json(users.listUsers());
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users
router.post('/users', (req, res) => {
  try {
    const body = req.body || {};

    if (typeof body.email === 'string') body.email = cleanStr(body.email, 200);
    if (typeof body.role === 'string') body.role = cleanStr(body.role, 50);
    if (typeof body.companyId === 'string') {
      body.companyId = cleanStr(body.companyId, 100) || null;
    }

    return res.status(201).json(users.createUser(body));
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users/:id/rotate-id
router.post('/users/:id/rotate-id', (req, res) => {
  try {
    return res.json(
      users.rotatePlatformIdAndForceReset(req.params.id, req.user.id)
    );
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/users/:id/subscription
router.post('/users/:id/subscription', (req, res) => {
  try {
    const patch = {};
    const body = req.body || {};

    if (typeof body.subscriptionStatus === 'string') {
      patch.subscriptionStatus = cleanStr(body.subscriptionStatus, 50);
    }

    // ✅ FIXED: correct field + legacy support
    if (typeof body.autoprotectEnabled !== 'undefined') {
      patch.autoprotectEnabled = !!body.autoprotectEnabled;
      patch.autoprotechEnabled = !!body.autoprotectEnabled; // legacy DB typo support
    }

    return res.json(
      users.updateUser(req.params.id, patch, req.user.id)
    );
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// ---------------- Companies ----------------

// GET /api/admin/companies
router.get('/companies', (req, res) => {
  try {
    return res.json(companies.listCompanies());
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// POST /api/admin/companies
router.post('/companies', (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.name === 'string') body.name = cleanStr(body.name, 200);

    return res.status(201).json(
      companies.createCompany({
        ...body,
        createdBy: req.user.id,
      })
    );
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// ---------------- Notifications ----------------

// GET /api/admin/notifications
router.get('/notifications', (req, res) => {
  try {
    return res.json(listNotifications({}));
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ======================================================
// ✅ Admin “Manager View” (read-only mirror)
// ======================================================

// GET /api/admin/manager/overview
router.get('/manager/overview', (req, res) => {
  try {
    const db = readDb();
    return res.json({
      users: db.users?.length || 0,
      companies: db.companies?.length || 0,
      auditEvents: db.audit?.length || 0,
      notifications: db.notifications?.length || 0,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/admin/manager/audit
router.get('/manager/audit', (req, res) => {
  try {
    const db = readDb();
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    return res.json((db.audit || []).slice(-limit).reverse());
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /api/admin/manager/notifications
router.get('/manager/notifications', (req, res) => {
  try {
    return res.json(listNotifications({}));
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
