// backend/src/routes/posture.routes.js
// Posture endpoints for cybersecurity rooms.
// Uses your existing auth stack: requires req.user to exist.
// If you don't have req.user on requests yet, tell me and we’ll wire auth middleware.

const express = require('express');
const router = express.Router();

const posture = require('../services/posture.service');

// simple guard (so endpoints don't crash)
function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: 'Unauthorized (missing user). Login first.' });
    return false;
  }
  return true;
}

// GET /api/posture/me  -> individual posture snapshot
router.get('/me', (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    return res.json(posture.getMyPosture({ user: req.user }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/company -> company posture snapshot
router.get('/company', (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    // optional: only allow Company / Admin / Manager
    const role = req.user?.role;
    if (!['Company','Admin','Manager'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden (company posture requires Company/Admin/Manager).' });
    }
    return res.json(posture.getCompanyPosture({ user: req.user }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/manager -> manager posture snapshot
router.get('/manager', (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    const role = req.user?.role;
    if (!['Manager','Admin'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden (manager posture requires Manager/Admin).' });
    }
    return res.json(posture.getManagerPosture({ user: req.user }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
