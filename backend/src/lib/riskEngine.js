// backend/src/lib/riskEngine.js
// AutoShield Tech — Enterprise Risk Engine v4
// Deterministic • Weighted • Cross-User Correlation • Privilege Sensitive • Auditable

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

const TOTAL_WEIGHT =
  GEO_WEIGHT + DEVICE_WEIGHT + SESSION_WEIGHT + BEHAVIOR_WEIGHT;

if (Math.round(TOTAL_WEIGHT * 100) !== 100) {
  throw new Error("Risk weights must total 1.0");
}

/* ========================================================= */

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
  const signals = [];

  if (!geo) {
    return { score: 20, signals: ["geo_missing"] };
  }

  if (!geo.country) {
    score += 20;
    signals.push("country_missing");
  }

  if (geo.country && HIGH_RISK_COUNTRIES.has(normalize(geo.country))) {
    score += 45;
    signals.push("high_risk_country");
  }

  if (geo.source === "fallback") {
    score += 15;
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
    score += 30;
    signals.push("ua_missing");
  }

  if (ua.includes("headless")) {
    score += 45;
    signals.push("headless_browser");
  }

  if (ua.includes("selenium")) {
    score += 45;
    signals.push("selenium_driver");
  }

  if (!device.language) {
    score += 10;
    signals.push("language_missing");
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
    score += 25;
    signals.push("multi_session");
  }

  if (activeSessions > 5) {
    score += 45;
    signals.push("excessive_sessions");
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
    score += 25;
    signals.push("multiple_failed_logins");
  }

  if (failedLogins >= 5) {
    score += 45;
    signals.push("excessive_failed_logins");
  }

  if (behavior.privilegeEscalationAttempt === true) {
    score += 60;
    signals.push("privilege_escalation_attempt");
  }

  return { score, signals };
}

/* =========================================================
   CROSS-USER CORRELATION
========================================================= */

function crossUserCorrelation(context = {}) {
  let score = 0;
  const signals = [];

  const {
    sameIpUserCount = 0,
    sameFingerprintUserCount = 0,
    elevatedUsersLast5Min = 0
  } = context;

  if (sameIpUserCount >= 3) {
    score += 20;
    signals.push("ip_cluster_activity");
  }

  if (sameFingerprintUserCount >= 2) {
    score += 25;
    signals.push("shared_device_across_users");
  }

  if (elevatedUsersLast5Min >= 3) {
    score += 30;
    signals.push("coordinated_risk_spike");
  }

  return { score, signals };
}

/* =========================================================
   CORRELATION BOOST
========================================================= */

function correlationBoost(geoRes, deviceRes) {
  if (
    geoRes.signals.includes("high_risk_country") &&
    deviceRes.signals.includes("headless_browser")
  ) {
    return 15;
  }
  return 0;
}

/* =========================================================
   LEVEL
========================================================= */

function deriveLevel(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 35) return "Medium";
  return "Low";
}

/* =========================================================
   MAIN CALCULATOR
========================================================= */

function calculateRisk({
  geo,
  device,
  session = {},
  behavior = {},
  baselineScore = null,
  role = null,
  correlationContext = null
}) {
  try {

    const geoRes = geoRisk(geo);
    const deviceRes = deviceRisk(device);
    const sessionRes = sessionRisk(session);
    const behaviorRes = behaviorRisk(behavior);

    const weighted =
      geoRes.score * GEO_WEIGHT +
      deviceRes.score * DEVICE_WEIGHT +
      sessionRes.score * SESSION_WEIGHT +
      behaviorRes.score * BEHAVIOR_WEIGHT;

    let finalScore = weighted;

    finalScore += correlationBoost(geoRes, deviceRes);

    /* Cross-user anomaly intelligence */
    if (correlationContext) {
      const correlationRes =
        crossUserCorrelation(correlationContext);

      finalScore += correlationRes.score;

      correlationContext._signals = correlationRes.signals;
    }

    /* Privilege sensitivity */
    if (role === "admin" || role === "finance") {
      finalScore *= 1.15;
    }

    finalScore = clamp(Math.round(finalScore), 0, 100);

    if (finalScore === 0) finalScore = 5;

    const level = deriveLevel(finalScore);

    const delta =
      baselineScore !== null
        ? finalScore - Number(baselineScore || 0)
        : null;

    const signals = Array.from(
      new Set([
        ...geoRes.signals,
        ...deviceRes.signals,
        ...sessionRes.signals,
        ...behaviorRes.signals,
        ...(correlationContext?._signals || [])
      ])
    );

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
      signals,
      timestamp: Date.now()
    };

  } catch {
    return {
      riskScore: 60,
      level: "High",
      fallback: true,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  calculateRisk
};
