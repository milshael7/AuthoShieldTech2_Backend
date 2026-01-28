// backend/src/routes/admin.routes.js
const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');

const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

// ✅ Safe role fallback (prevents save/build issues if users.ROLES is missing)
const ADMIN_ROLE = (users && users.ROLES && users.ROLES.ADMIN) ? users.ROLES.ADMIN : 'Admin';

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

// --- Users ---
router.get('/users', (req, res) => res.json(users.listUsers()));

router.post('/users', (req, res) => {
  try {
    res.status(201).json(users.createUser(req.body));
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post('/users/:id/rotate-id', (req, res) => {
  try {
    res.json(users.rotatePlatformIdAndForceReset(req.params.id, req.user.id));
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post('/users/:id/subscription', (req, res) => {
  try {
    const patch = {};

    if (req.body && typeof req.body.subscriptionStatus === 'string') {
      patch.subscriptionStatus = req.body.subscriptionStatus;
    }

    // ✅ Keep compatibility with your existing schema typo (autoprotechEnabled)
    if (req.body && typeof req.body.autoprotectEnabled !== 'undefined') {
      patch.autoprotechEnabled = !!req.body.autoprotectEnabled;
    }

    res.json(users.updateUser(req.params.id, patch, req.user.id));
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// --- Companies ---
router.get('/companies', (req, res) => res.json(companies.listCompanies()));

router.post('/companies', (req, res) => {
  try {
    res.status(201).json(companies.createCompany({ ...req.body, createdBy: req.user.id }));
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// --- Notifications ---
router.get('/notifications', (req, res) => res.json(listNotifications({})));

// ======================================================
// ✅ Admin “Manager View” (read-only): overview + audit
// (So Admin can see what Manager sees without switching)
// ======================================================

router.get('/manager/overview', (req, res) => {
  const db = readDb();
  res.json({
    users: db.users?.length || 0,
    companies: db.companies?.length || 0,
    auditEvents: db.audit?.length || 0,
    notifications: db.notifications?.length || 0,
    time: new Date().toISOString(),
  });
});

router.get('/manager/audit', (req, res) => {
  const db = readDb();
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const items = (db.audit || []).slice(-limit).reverse();
  res.json(items);
});

router.get('/manager/notifications', (req, res) => {
  res.json(listNotifications({}));
});

module.exports = router;
