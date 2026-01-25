// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config (owner controls)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// OPTIONAL protection for reset/config.
// Set env PAPER_RESET_KEY to something long.
// Then call POST /api/paper/reset or POST /api/paper/config with header:
// x-reset-key: <your key>
function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true; // if you don't set it, endpoints are open (not recommended)
  const sent = String(req.headers['x-reset-key'] || '').trim();
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
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Reset blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY on backend).'
      });
    }

    paperTrader.hardReset();
    return res.json({
      ok: true,
      message: 'Paper wallet reset complete.',
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ GET /api/paper/config -> shows current settings + sizing state
router.get('/config', (req, res) => {
  try {
    const snap = paperTrader.snapshot();
    return res.json({
      ok: true,
      owner: snap.owner || null,
      sizing: snap.sizing || null,
      limits: snap.limits || null,
      config: snap.config || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ POST /api/paper/config -> set baselinePct, maxPct, maxTradesPerDay
router.post('/config', (req, res) => {
  try {
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Config update blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY on backend).'
      });
    }

    const { baselinePct, maxPct, maxTradesPerDay } = req.body || {};
    const updated = paperTrader.setConfig({ baselinePct, maxPct, maxTradesPerDay });

    const snap = paperTrader.snapshot();
    return res.json({
      ok: true,
      owner: updated,
      sizing: snap.sizing,
      limits: snap.limits
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
