// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config (owner controls)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// OPTIONAL protection so random people can’t reset/change your paper brain.
// Set env PAPER_RESET_KEY and PAPER_CONFIG_KEY (recommended).
// - Reset:  POST /api/paper/reset   header: x-reset-key: <key>
// - Config: POST /api/paper/config  header: x-config-key: <key>
function hasKey(req, envName) {
  const key = String(process.env[envName] || '').trim();
  if (!key) return true; // if you don't set it, it's open (not recommended)
  const sent = String(req.headers['x-reset-key'] || req.headers['x-config-key'] || '').trim();
  return sent && sent === key;
}

// GET /api/paper/status
router.get('/status', (req, res) => {
  try {
    return res.json(paperTrader.snapshot());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/paper/reset
router.post('/reset', (req, res) => {
  try {
    if (!hasKey(req, 'PAPER_RESET_KEY')) {
      return res.status(403).json({
        ok: false,
        error: 'Reset blocked. Missing/invalid key. Set PAPER_RESET_KEY on backend.',
      });
    }

    paperTrader.hardReset();
    return res.json({
      ok: true,
      message: 'Paper wallet reset complete.',
      snapshot: paperTrader.snapshot(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ POST /api/paper/config  (owner controls)
router.post('/config', (req, res) => {
  try {
    if (!hasKey(req, 'PAPER_CONFIG_KEY')) {
      return res.status(403).json({
        ok: false,
        error: 'Config blocked. Missing/invalid key. Set PAPER_CONFIG_KEY on backend.',
      });
    }

    const patch = req.body || {};
    if (typeof paperTrader.setConfig !== 'function') {
      return res.status(400).json({
        ok: false,
        error: 'paperTrader.setConfig() not found. Make sure you replaced backend/src/services/paperTrader.js with the version that exports setConfig.',
      });
    }

    const owner = paperTrader.setConfig({
      baselinePct: patch.baselinePct,
      maxPct: patch.maxPct,
      maxTradesPerDay: patch.maxTradesPerDay,
    });

    return res.json({
      ok: true,
      owner,
      snapshot: paperTrader.snapshot(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
