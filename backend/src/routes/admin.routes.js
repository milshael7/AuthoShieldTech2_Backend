const express = require('express');
const router = express.Router();
const { authRequired, requireRole } = require('../middleware/auth');
const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

router.use(authRequired);
router.use(requireRole(users.ROLES.ADMIN));

// --- Users ---
router.get('/users', (req, res) => res.json(users.listUsers()));

router.post('/users', (req, res) => {
  try {
    res.status(201).json(users.createUser(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:id/rotate-id', (req, res) => {
  try {
    res.json(users.rotatePlatformIdAndForceReset(req.params.id, req.user.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:id/subscription', (req, res) => {
  try {
    const patch = {};
    if (req.body && typeof req.body.subscriptionStatus === 'string') {
      patch.subscriptionStatus = req.body.subscriptionStatus;
    }
    if (req.body && typeof req.body.autoprotectEnabled !== 'undefined') {
      // maintain backward compatibility with the existing schema typo
      patch.autoprotechEnabled = !!req.body.autoprotectEnabled;
    }
    res.json(users.updateUser(req.params.id, patch, req.user.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Companies ---
router.get('/companies', (req, res) => res.json(companies.listCompanies()));

router.post('/companies', (req, res) => {
  try {
    res.status(201).json(companies.createCompany({ ...req.body, createdBy: req.user.id }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Notifications ---
router.get('/notifications', (req, res) => res.json(listNotifications({})));

module.exports = router;
