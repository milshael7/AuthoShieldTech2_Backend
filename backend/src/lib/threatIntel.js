// backend/src/lib/threatIntel.js
// AutoShield Tech — Enterprise Threat Intelligence Engine v3
// Deterministic • Correlation-Aware • Privilege-Sensitive • Auditable

/* =========================================================
   CONFIG
========================================================= */

const BAD_IP_LIST = new Set(
  (process.env.KNOWN_BAD_IPS || "")
    .split(",")
    .map(ip => String(ip).trim())
    .filter(Boolean)
);

const SUSPICIOUS_AGENTS = (
  process.env.SUSPICIOUS_UA_FRAGMENTS ||
  "headless,selenium,phantom,crawler,bot"
)
  .split(",")
  .map(x => x.trim().toLowerCase());

const IP_WEIGHT = 0.30;
const UA_WEIGHT = 0.25;
const FP_WEIGHT = 0.25;
const BEHAVIOR_WEIGHT = 0.20;

/* Weight integrity check */
const TOTAL_WEIGHT =
  IP_WEIGHT + UA_WEIGHT + FP_WEIGHT + BEHAVIOR_WEIGHT;

if (Math.round(TOTAL_WEIGHT * 100) !== 100) {
  throw new Error("ThreatIntel weights must total 1.0");
}

/* ========================================================= */

function normalize(v) {
  return String(v || "").toLowerCase().trim();
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function deriveLevel(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 35) return "Medium";
  return "Low";
}

function isPrivateIp(ip) {
  return (
    ip.startsWith("127.") ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.")
  );
}

/* =========================================================
   IP REPUTATION
========================================================= */

function ipThreat(ip) {
  const signals = [];
  let score = 0;

  if (!ip) {
    score += 25;
    signals.push("ip_missing");
    return { score, signals };
  }

  if (isPrivateIp(ip)) {
    return { score: 0, signals: ["internal_ip"] };
  }

  if (BAD_IP_LIST.has(ip)) {
    score += 95;
    signals.push("known_malicious_ip");
    return { score, signals };
  }

  score += 10;
  signals.push("unknown_ip");

  return { score, signals };
}

/* =========================================================
   USER AGENT ANALYSIS
========================================================= */

function uaThreat(userAgent) {
  const ua = normalize(userAgent);
  const signals = [];
  let score = 0;

  if (!ua) {
    score += 35;
    signals.push("ua_missing");
    return { score, signals };
  }

  for (const fragment of SUSPICIOUS_AGENTS) {
    if (ua.includes(fragment)) {
      score += 55;
      signals.push(`ua_fragment_${fragment}`);
    }
  }

  if (score === 0) {
    score += 5;
    signals.push("ua_normal");
  }

  return { score, signals };
}

/* =========================================================
   FINGERPRINT DRIFT
========================================================= */

function fingerprintThreat(current, previous) {
  const signals = [];
  let score = 0;

  if (!previous) {
    score += 15;
    signals.push("first_seen_device");
    return { score, signals };
  }

  if (current && previous && String(current) !== String(previous)) {
    score += 45;
    signals.push("fingerprint_changed");
  }

  return { score, signals };
}

/* =========================================================
   BEHAVIORAL SIGNALS
========================================================= */

function behaviorThreat({
  failedLogins = 0,
  rapidRequests = false
}) {
  const signals = [];
  let score = 0;

  if (failedLogins >= 3) {
    score += 30;
    signals.push("multiple_failed_logins");
  }

  if (failedLogins >= 5) {
    score += 45;
    signals.push("excessive_failed_logins");
  }

  if (rapidRequests === true) {
    score += 35;
    signals.push("rapid_requests");
  }

  return { score, signals };
}

/* =========================================================
   CORRELATION BOOST
========================================================= */

function correlationBoost(ipRes, uaRes) {
  if (
    ipRes.signals.includes("known_malicious_ip") &&
    uaRes.signals.some(s => s.startsWith("ua_fragment_"))
  ) {
    return 20; // hostile automation
  }

  return 0;
}

/* =========================================================
   MAIN THREAT EVALUATOR
========================================================= */

function evaluateThreat({
  ip,
  userAgent,
  fingerprint,
  previousFingerprint,
  failedLogins = 0,
  rapidRequests = false,
  baselineScore = null,
  role = null
}) {
  try {
    const ipRes = ipThreat(ip);
    const uaRes = uaThreat(userAgent);
    const fpRes = fingerprintThreat(fingerprint, previousFingerprint);
    const behaviorRes = behaviorThreat({
      failedLogins,
      rapidRequests
    });

    let weighted =
      ipRes.score * IP_WEIGHT +
      uaRes.score * UA_WEIGHT +
      fpRes.score * FP_WEIGHT +
      behaviorRes.score * BEHAVIOR_WEIGHT;

    /* Correlation spike */
    weighted += correlationBoost(ipRes, uaRes);

    /* Privilege sensitivity */
    if (role === "admin" || role === "finance") {
      weighted *= 1.15;
    }

    let finalScore = clamp(Math.round(weighted), 0, 100);

    if (finalScore === 0) {
      finalScore = 5;
    }

    const level = deriveLevel(finalScore);

    const delta =
      baselineScore !== null
        ? finalScore - Number(baselineScore || 0)
        : null;

    const signals = Array.from(
      new Set([
        ...ipRes.signals,
        ...uaRes.signals,
        ...fpRes.signals,
        ...behaviorRes.signals
      ])
    );

    return {
      threatScore: finalScore,
      level,
      delta,
      breakdown: {
        ip: ipRes,
        userAgent: uaRes,
        fingerprint: fpRes,
        behavior: behaviorRes
      },
      signals,
      timestamp: Date.now()
    };

  } catch {
    return {
      threatScore: 65,
      level: "High",
      fallback: true,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  evaluateThreat
};
