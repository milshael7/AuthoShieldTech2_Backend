// backend/src/lib/threatIntel.js
// Enterprise Threat Intelligence Engine — v2 (Deterministic + Weighted + Auditable)
// IP Reputation • User-Agent Detection • Fingerprint Drift • Behavioral Signals
// ZeroTrust + RiskEngine v2 Compatible

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

/* =========================================================
   HELPERS
========================================================= */

function normalize(v) {
  return String(v || "").toLowerCase().trim();
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function deriveLevel(score) {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

/* =========================================================
   IP REPUTATION
========================================================= */

function ipThreat(ip) {
  const signals = [];
  let score = 0;

  if (!ip) {
    score += 20;
    signals.push("ip_missing");
    return { score, signals };
  }

  if (BAD_IP_LIST.has(ip)) {
    score += 90;
    signals.push("known_malicious_ip");
    return { score, signals };
  }

  if (ip.startsWith("127.") || ip === "::1") {
    return { score: 0, signals: ["localhost"] };
  }

  score += 5;
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
    score += 30;
    signals.push("ua_missing");
    return { score, signals };
  }

  for (const fragment of SUSPICIOUS_AGENTS) {
    if (ua.includes(fragment)) {
      score += 50;
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
    score += 10;
    signals.push("first_seen_device");
    return { score, signals };
  }

  if (current && previous && String(current) !== String(previous)) {
    score += 40;
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
    score += 25;
    signals.push("multiple_failed_logins");
  }

  if (failedLogins >= 5) {
    score += 40;
    signals.push("excessive_failed_logins");
  }

  if (rapidRequests === true) {
    score += 30;
    signals.push("rapid_requests");
  }

  return { score, signals };
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
  baselineScore = null
}) {
  try {
    const ipRes = ipThreat(ip);
    const uaRes = uaThreat(userAgent);
    const fpRes = fingerprintThreat(fingerprint, previousFingerprint);
    const behaviorRes = behaviorThreat({
      failedLogins,
      rapidRequests
    });

    const weighted =
      ipRes.score * IP_WEIGHT +
      uaRes.score * UA_WEIGHT +
      fpRes.score * FP_WEIGHT +
      behaviorRes.score * BEHAVIOR_WEIGHT;

    const finalScore = clamp(Math.round(weighted), 0, 100);
    const level = deriveLevel(finalScore);

    const delta =
      baselineScore !== null
        ? finalScore - Number(baselineScore || 0)
        : null;

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
      signals: [
        ...ipRes.signals,
        ...uaRes.signals,
        ...fpRes.signals,
        ...behaviorRes.signals
      ],
      timestamp: Date.now()
    };

  } catch {
    return {
      threatScore: 50,
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
  evaluateThreat
};
