const express = require('express');
const router = express.Router();
const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');
const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

router.use(authRequired);
router.use(requireRole(users.ROLES.ADMIN, users.ROLES.MANAGER));

// Overview counts for manager room
router.get('/overview', (req, res) => {
  const db = readDb();
  res.json({
    users: db.users?.length || 0,
    companies: db.companies?.length || 0,
    auditEvents: db.audit?.length || 0,
    notifications: db.notifications?.length || 0,
    time: new Date().toISOString(),
  });
});

// Read-only lists
router.get('/users', (req, res) => res.json(users.listUsers()));
router.get('/companies', (req, res) => res.json(companies.listCompanies()));
router.get('/notifications', (req, res) => res.json(listNotifications({})));

// Audit log (read-only)
router.get('/audit', (req, res) => {
  const db = readDb();
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const items = (db.audit || []).slice(-limit).reverse();
  res.json(items);
});

module.exports = router;
