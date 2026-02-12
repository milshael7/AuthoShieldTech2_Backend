const express = require("express");
const router = express.Router();

const {
  recordVisit,
  getSummary,
} = require("../services/analyticsEngine");

/* =============================================
   RECORD VISIT
============================================= */

router.post("/event", (req, res) => {
  const { path, duration, country, referrer } = req.body;

  const entry = recordVisit({
    path,
    duration,
    country,
    referrer,
    userAgent: req.headers["user-agent"],
  });

  return res.json({ ok: true, entry });
});

/* =============================================
   GET SUMMARY
============================================= */

router.get("/summary", (req, res) => {
  const summary = getSummary();
  return res.json({ ok: true, summary });
});

module.exports = router;
