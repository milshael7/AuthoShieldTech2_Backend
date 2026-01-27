// backend/src/routes/posture.routes.js
// Read-only posture endpoints for ALL rooms

const express = require("express");
const router = express.Router();

const { buildPosture } = require("../services/posture.service");

// NOTE:
// If your app has auth middleware (req.user), it will automatically enrich role.
// If not, these still work and return safe defaults.

router.get("/me", (req, res) => {
  try {
    return res.json(buildPosture({ scope: "me", actor: req.user || null }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.get("/company", (req, res) => {
  try {
    return res.json(buildPosture({ scope: "company", actor: req.user || null }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.get("/manager", (req, res) => {
  try {
    return res.json(buildPosture({ scope: "manager", actor: req.user || null }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
