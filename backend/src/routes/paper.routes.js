// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config (owner controls)
// ✅ reset can be protected with PAPER_RESET_KEY (x-reset-key)
// ✅ config can be protected with PAPER_OWNER_KEY (x-owner-key)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// ------------------ simple key gates ------------------
// If you DON'T set a key, that action is OPEN (not recommended).

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-reset-key'] || '').trim();
  return sent && sent === key;
}

function ownerAllowed(req) {
  const key = String(process.env.PAPER_OWNER_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-owner-key'] || '').trim();
  return sent && sent === key;
}

// ------------------ routes ------------------

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
      stateFile: process.env.PAPER_STATE_PATH || '(default from paperTrader)',
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ GET /api/paper/config  (read-only; returns current owner knobs + sizing)
router.get('/config', (req, res) => {
  try {
    const snap = paperTrader.snapshot();
    return res.json({
      ok: true,
      owner: snap.owner || {},
      sizing: snap.sizing || {},
      limits: snap.limits || {},
      time: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ POST /api/paper/config  (owner sets baseline/max/trades-per-day)
router.post('/config', (req, res) => {
  try {
    if (!ownerAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Config blocked. Missing/invalid x-owner-key (set PAPER_OWNER_KEY on backend).'
      });
    }

    // Accept only these fields
    const patch = {};
    if (req.body && req.body.baselinePct != null) patch.baselinePct = req.body.baselinePct;
    if (req.body && req.body.maxPct != null) patch.maxPct = req.body.maxPct;
    if (req.body && req.body.maxTradesPerDay != null) patch.maxTradesPerDay = req.body.maxTradesPerDay;

    const owner = paperTrader.setConfig(patch);
    const snap = paperTrader.snapshot();

    return res.json({
      ok: true,
      message: 'Paper config updated.',
      owner,
      sizing: snap.sizing || {},
      limits: snap.limits || {},
      time: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
