// backend/src/routes/admin.routes.js
const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');

const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

router.use(authRequired);
router.use(requireRole(users.ROLES.ADMIN));

// ---------------- Users ----------------
router.get('/users', (req, res) => {
  try {
    return res.json(users.listUsers());
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post('/users', (req, res) => {
  try {
    // Optional: basic cleanup (prevents weird saves)
    const body = req.body || {};
    if (typeof body.email === 'string') body.email = body.email.trim();
    if (typeof body.role === 'string') body.role = body.role.trim();
    if (typeof body.companyId === 'string') body.companyId = body.companyId.trim() || null;

    return res.status(201).json(users.createUser(body));
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post('/users/:id/rotate-id', (req, res) => {
  try {
    return res.json(users.rotatePlatformIdAndForceReset(req.params.id, req.user.id));
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post('/users/:id/subscription', (req, res) => {
  try {
    const patch = {};
    const body = req.body || {};

    if (typeof body.subscriptionStatus === 'string') {
      patch.subscriptionStatus = body.subscriptionStatus.trim();
    }

    // ✅ Keep compatibility with your existing schema typo (autoprotechEnabled)
    if (typeof body.autoprotectEnabled !== 'undefined') {
      patch.autoprotechEnabled = !!body.autoprotectEnabled;
    }

    return res.json(users.updateUser(req.params.id, patch, req.user.id));
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// ---------------- Companies ----------------
router.get('/companies', (req, res) => {
  try {
    return res.json(companies.listCompanies());
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post('/companies', (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.name === 'string') body.name = body.name.trim();

    return res.status(201).json(
      companies.createCompany({ ...body, createdBy: req.user.id })
    );
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// ---------------- Notifications ----------------
router.get('/notifications', (req, res) => {
  try {
    return res.json(listNotifications({}));
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ======================================================
// ✅ Admin “Manager View” (read-only): overview + audit
// (Admin can already access /api/manager/*, but this keeps
// an admin-only mirror if you want it.)
// ======================================================

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

router.get('/manager/audit', (req, res) => {
  try {
    const db = readDb();
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const items = (db.audit || []).slice(-limit).reverse();
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get('/manager/notifications', (req, res) => {
  try {
    return res.json(listNotifications({}));
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
