// backend/src/lib/riskEngine.js
// Enterprise Risk Engine — Adaptive v2 (Deterministic + Auditable)
// Device • Geo • Session • Behavioral • Weighted Correlation
// ZeroTrust + WebSocket Compatible

/* =========================================================
   CONFIG
========================================================= */

const HIGH_RISK_COUNTRIES = new Set(
  (process.env.HIGH_RISK_COUNTRIES || "north korea,iran")
    .split(",")
    .map(c => String(c).trim().toLowerCase())
);

const GEO_WEIGHT = 0.20;
const DEVICE_WEIGHT = 0.25;
const SESSION_WEIGHT = 0.25;
const BEHAVIOR_WEIGHT = 0.30;

/* =========================================================
   HELPERS
========================================================= */

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function normalize(str) {
  return String(str || "").toLowerCase().trim();
}

/* =========================================================
   GEO RISK
========================================================= */

function geoRisk(geo) {
  let score = 0;

  if (!geo) {
    return {
      score: 15,
      signals: ["geo_missing"]
    };
  }

  const signals = [];

  if (!geo.country) {
    score += 15;
    signals.push("country_missing");
  }

  if (geo.country && HIGH_RISK_COUNTRIES.has(normalize(geo.country))) {
    score += 40;
    signals.push("high_risk_country");
  }

  if (geo.source === "fallback") {
    score += 10;
    signals.push("geo_fallback");
  }

  return { score, signals };
}

/* =========================================================
   DEVICE RISK
========================================================= */

function deviceRisk(device = {}) {
  let score = 0;
  const signals = [];

  const ua = normalize(device.userAgent);

  if (!ua) {
    score += 25;
    signals.push("ua_missing");
  }

  if (ua.includes("headless")) {
    score += 40;
    signals.push("headless_browser");
  }

  if (ua.includes("phantom")) {
    score += 35;
    signals.push("phantom_driver");
  }

  if (ua.includes("selenium")) {
    score += 40;
    signals.push("selenium_driver");
  }

  if (!device.language) {
    score += 10;
    signals.push("language_missing");
  }

  if (!device.timezone) {
    score += 10;
    signals.push("timezone_missing");
  }

  return { score, signals };
}

/* =========================================================
   SESSION RISK
========================================================= */

function sessionRisk(session = {}) {
  let score = 0;
  const signals = [];

  const activeSessions = Number(session.activeSessions || 0);

  if (activeSessions > 3) {
    score += 20;
    signals.push("multi_session");
  }

  if (activeSessions > 5) {
    score += 40;
    signals.push("excessive_sessions");
  }

  if (session.tokenVersionMismatch === true) {
    score += 50;
    signals.push("token_version_mismatch");
  }

  return { score, signals };
}

/* =========================================================
   BEHAVIOR RISK
========================================================= */

function behaviorRisk(behavior = {}) {
  let score = 0;
  const signals = [];

  const failedLogins = Number(behavior.failedLogins || 0);

  if (failedLogins >= 3) {
    score += 20;
    signals.push("multiple_failed_logins");
  }

  if (failedLogins >= 5) {
    score += 40;
    signals.push("excessive_failed_logins");
  }

  if (behavior.rapidRequests === true) {
    score += 25;
    signals.push("rapid_requests");
  }

  if (behavior.privilegeEscalationAttempt === true) {
    score += 50;
    signals.push("privilege_escalation_attempt");
  }

  return { score, signals };
}

/* =========================================================
   LEVEL DERIVATION
========================================================= */

function deriveLevel(score) {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

/* =========================================================
   MAIN RISK CALCULATOR
========================================================= */

function calculateRisk({
  geo,
  device,
  session = {},
  behavior = {},
  baselineScore = null
}) {
  try {
    const geoRes = geoRisk(geo);
    const deviceRes = deviceRisk(device);
    const sessionRes = sessionRisk(session);
    const behaviorRes = behaviorRisk(behavior);

    // Weighted model (deterministic)
    const weighted =
      geoRes.score * GEO_WEIGHT +
      deviceRes.score * DEVICE_WEIGHT +
      sessionRes.score * SESSION_WEIGHT +
      behaviorRes.score * BEHAVIOR_WEIGHT;

    const finalScore = clamp(Math.round(weighted), 0, 100);
    const level = deriveLevel(finalScore);

    const delta =
      baselineScore !== null
        ? finalScore - Number(baselineScore || 0)
        : null;

    return {
      riskScore: finalScore,
      level,
      delta,
      breakdown: {
        geo: geoRes,
        device: deviceRes,
        session: sessionRes,
        behavior: behaviorRes
      },
      signals: [
        ...geoRes.signals,
        ...deviceRes.signals,
        ...sessionRes.signals,
        ...behaviorRes.signals
      ],
      timestamp: Date.now()
    };

  } catch {
    return {
      riskScore: 50,
      level: "Medium",
      fallback: true,
      timestamp: Date.now()
    };
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  calculateRisk
};
