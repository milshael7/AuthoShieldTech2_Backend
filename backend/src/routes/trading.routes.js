// backend/src/routes/trading.routes.js
const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const paperTrader = require('../services/paperTrader');
const liveTrader = require('../services/liveTrader');

/**
 * TRADING ROUTES
 *
 * Design rules:
 * - NO mock market logic
 * - NO duplicated live state
 * - Routes are THIN
 * - Decisions happen in tradeBrain
 * - Execution handled by paperTrader / liveTrader
 */

// ---------- ROLE HELPERS ----------
function isAdmin(req) {
  return req?.user?.role === 'admin';
}

function isManagerOrAdmin(req) {
  return req?.user?.role === 'admin' || req?.user?.role === 'manager';
}

// ---------- PUBLIC (NO AUTH) ----------

// Supported symbols (frontend helpers)
router.get('/symbols', (req, res) => {
  res.json({
    ok: true,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  });
});

// ---------- PROTECTED ----------
router.use(authRequired);

// ---------- PAPER TRADING ----------

/**
 * GET /api/trading/paper/snapshot
 * Admin + Manager
 */
router.get('/paper/snapshot', (req, res) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  res.json({
    ok: true,
    snapshot: paperTrader.snapshot(),
  });
});

/**
 * POST /api/trading/paper/config
 * Admin only
 */
router.post('/paper/config', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  const updated = paperTrader.setConfig(req.body || {});
  res.json({ ok: true, config: updated });
});

/**
 * POST /api/trading/paper/reset
 * Admin only
 */
router.post('/paper/reset', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  paperTrader.hardReset();
  res.json({ ok: true });
});

// ---------- LIVE TRADING (SAFE) ----------

/**
 * GET /api/trading/live/snapshot
 * Admin + Manager
 */
router.get('/live/snapshot', (req, res) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  res.json(liveTrader.snapshot());
});

/**
 * POST /api/trading/live/signal
 * Admin only
 * (Signals are logged; execution depends on env + arming)
 */
router.post('/live/signal', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  const result = await liveTrader.pushSignal(req.body || {});
  res.json(result);
});

module.exports = router;
