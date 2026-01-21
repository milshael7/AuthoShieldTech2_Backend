// backend/src/routes/paper.routes.js
const express = require("express");
const router = express.Router();

const paperTrader = require("../services/paperTrader");

// GET status
router.get("/status", (req, res) => {
  res.json(paperTrader.snapshot());
});

// POST config update (owner/admin usage)
router.post("/config", (req, res) => {
  try {
    const patch = req.body || {};
    const cfg = paperTrader.updateConfig(patch);
    res.json({ ok: true, config: cfg });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST reset paper engine (paper-only)
router.post("/reset", (req, res) => {
  paperTrader.hardReset();
  res.json({ ok: true, message: "Paper system reset (wallets + trades + learning).", state: paperTrader.snapshot() });
});

module.exports = router;
