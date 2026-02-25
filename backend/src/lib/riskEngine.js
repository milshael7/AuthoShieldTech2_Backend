// backend/src/lib/riskEngine.js
// Enterprise Risk Engine — Adaptive v1
// Device Risk • Geo Risk • Session Risk • Behavioral Risk • Deterministic Scoring

/* =========================================================
   HELPERS
========================================================= */

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function normalize(str) {
  return String(str || "").toLowerCase();
}

/* =========================================================
   GEO RISK
========================================================= */

function geoRisk(geo) {
  if (!geo) return 15;

  let score = 0;

  if (!geo.country) score += 15;

  // High-risk region example logic (extendable)
  const highRiskCountries = ["north korea", "iran"];

  if (
    geo.country &&
    highRiskCountries.includes(normalize(geo.country))
  ) {
    score += 40;
  }

  if (geo.source === "fallback") score += 10;

  return score;
}

/* =========================================================
   DEVICE RISK
========================================================= */

function deviceRisk(device = {}) {
  let score = 0;

  const ua = normalize(device.userAgent);

  if (!ua) score += 25;

  if (ua.includes("headless")) score += 40;
  if (ua.includes("phantom")) score += 35;
  if (ua.includes("selenium")) score += 40;

  if (!device.language) score += 10;
  if (!device.timezone) score += 10;

  return score;
}

/* =========================================================
   SESSION RISK
========================================================= */

function sessionRisk({ activeSessions = 0, tokenVersionMismatch = false }) {
  let score = 0;

  if (activeSessions > 3) score += 20;
  if (activeSessions > 5) score += 40;

  if (tokenVersionMismatch) score += 50;

  return score;
}

/* =========================================================
   BEHAVIOR RISK
========================================================= */

function behaviorRisk({
  failedLogins = 0,
  rapidRequests = false,
  privilegeEscalationAttempt = false
}) {
  let score = 0;

  if (failedLogins >= 3) score += 20;
  if (failedLogins >= 5) score += 40;

  if (rapidRequests) score += 25;
  if (privilegeEscalationAttempt) score += 50;

  return score;
}

/* =========================================================
   MAIN RISK CALCULATOR
========================================================= */

function calculateRisk({
  geo,
  device,
  session = {},
  behavior = {}
}) {
  try {
    let score = 0;

    score += geoRisk(geo);
    score += deviceRisk(device);
    score += sessionRisk(session);
    score += behaviorRisk(behavior);

    score = clamp(score, 0, 100);

    let level = "Low";

    if (score >= 70) level = "Critical";
    else if (score >= 45) level = "High";
    else if (score >= 25) level = "Medium";

    return {
      riskScore: score,
      level,
      timestamp: Date.now()
    };

  } catch {
    return {
      riskScore: 50,
      level: "Medium",
      timestamp: Date.now(),
      fallback: true
    };
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  calculateRisk
};
