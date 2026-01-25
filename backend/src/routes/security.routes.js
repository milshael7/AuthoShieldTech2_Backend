// backend/src/routes/security.routes.js
const express = require('express');
const router = express.Router();

// MVP posture data (replace with real scanners later)
router.get('/posture', (req, res) => {
  // scores: 0..100, issues: integer
  const posture = {
    updatedAt: new Date().toISOString(),
    domains: [
      { key: "email", label: "Email Protection", coverage: 82, issues: 2 },
      { key: "endpoint", label: "Endpoint Security", coverage: 76, issues: 4 },
      { key: "awareness", label: "Security Awareness", coverage: 68, issues: 1 },
      { key: "phishing", label: "Phishing Simulations", coverage: 55, issues: 3 },
      { key: "itdr", label: "ITDR", coverage: 61, issues: 2 },
      { key: "external", label: "External Footprint", coverage: 73, issues: 5 },
      { key: "darkweb", label: "Dark Web", coverage: 64, issues: 1 },
      { key: "cloud", label: "Cloud Data", coverage: 70, issues: 2 },
      { key: "browsing", label: "Secure Browsing", coverage: 79, issues: 2 },
    ]
  };

  return res.json({ ok: true, posture });
});

module.exports = router;
