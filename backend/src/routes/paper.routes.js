// backend/src/routes/paper.routes.js
const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');
const { authRequired, requireRole } = require('../middleware/auth');

// Status for UI
router.get('/status', (req, res) => {
  res.json(paperTrader.snapshot());
});

// Admin/Manager: reset paper brain (paper only)
router.post('/reset', authRequired, requireRole('Admin', 'Manager'), (req, res) => {
  paperTrader.hardReset();
  res.json({ ok: true, message: 'Paper trader reset complete.' });
});

module.exports = router;
