// backend/src/routes/paper.routes.js
// Paper trading control routes (status + reset)
// Uses the NON-RESETTING paperTrader "brain"

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');
const { authRequired, requireRole } = require('../middleware/auth');

/**
 * GET /api/paper/status
 * Public-ish (logged-in) read-only snapshot
 */
router.get('/status', authRequired, (req, res) => {
  try {
    res.json(paperTrader.snapshot());
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || 'Failed to load paper status'
    });
  }
});

/**
 * POST /api/paper/reset
 * ADMIN ONLY
 * Hard reset paper wallet + learning stats
 * (Does NOT affect live trading)
 */
router.post(
  '/reset',
  authRequired,
  requireRole('Admin'),
  (req, res) => {
    try {
      paperTrader.hardReset();
      res.json({
        ok: true,
        message: 'Paper trader reset successfully'
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e?.message || 'Reset failed'
      });
    }
  }
);

module.exports = router;
