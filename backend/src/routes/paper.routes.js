// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config (owner controls)
// ✅ reset can be protected with PAPER_RESET_KEY (x-reset-key)
// ✅ config can be protected with PAPER_OWNER_KEY (x-owner-key)
// ✅ returns "config" so frontend Trading Controls can load/save without breaking

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// ------------------ simple key gates ------------------
// If you DON'T set a key, that action is OPEN (not recommended).

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-reset-key'] || '').trim();
  return !!sent && sent === key;
}

function ownerAllowed(req) {
  const key = String(process.env.PAPER_OWNER_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-owner-key'] || '').trim();
  return !!sent && sent === key;
}

// Coerce + clamp inputs safely
function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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

// ✅ GET /api/paper/config
// Frontend expects either:
//   { config: {...} }  OR the config object itself.
// We'll return BOTH for compatibility + keep your old keys too.
router.get('/config', (req, res) => {
  try {
    const snap = paperTrader.snapshot();

    // paperTrader may store owner knobs in different places, so normalize
    const cfg =
      snap.config ||
      snap.owner ||
      snap.paperConfig ||
      {
        baselinePct: 0.02,
        maxPct: 0.05,
        maxTradesPerDay: 12
      };

    return res.json({
      ok: true,
      config: cfg,            // ✅ what frontend reads
      owner: cfg,             // ✅ backward compatible with your earlier response shape
      sizing: snap.sizing || {},
      limits: snap.limits || {},
      time: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ POST /api/paper/config
// Owner sets baselinePct/maxPct/maxTradesPerDay
router.post('/config', (req, res) => {
  try {
    if (!ownerAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Config blocked. Missing/invalid x-owner-key (set PAPER_OWNER_KEY on backend).'
      });
    }

    const body = req.body || {};

    // sanitize + clamp
    const patch = {};

    if (body.baselinePct != null) patch.baselinePct = clamp(toNum(body.baselinePct, 0.02), 0, 1);
    if (body.maxPct != null) patch.maxPct = clamp(toNum(body.maxPct, 0.05), 0, 1);
    if (body.maxTradesPerDay != null) patch.maxTradesPerDay = clamp(toInt(body.maxTradesPerDay, 12), 1, 1000);

    if (
      patch.baselinePct != null &&
      patch.maxPct != null &&
      patch.maxPct < patch.baselinePct
    ) {
      return res.status(400).json({ ok: false, error: 'maxPct must be >= baselinePct' });
    }

    // Apply + return normalized result
    const cfg = paperTrader.setConfig(patch);
    const snap = paperTrader.snapshot();

    return res.json({
      ok: true,
      message: 'Paper config updated.',
      config: cfg,            // ✅ frontend-friendly
      owner: cfg,             // ✅ backward compatible
      sizing: snap.sizing || {},
      limits: snap.limits || {},
      time: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
