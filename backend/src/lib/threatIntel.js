// backend/src/lib/threatIntel.js
// Enterprise Threat Intelligence Engine — v1
// IP Reputation • Device Signature Detection • Behavioral Indicators • Correlation Layer

/* =========================================================
   HELPERS
========================================================= */

function normalize(v) {
  return String(v || "").toLowerCase();
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

/* =========================================================
   STATIC THREAT LISTS (Upgradeable Later)
========================================================= */

// Placeholder for known malicious IPs (replace with DB or feed later)
const knownBadIps = new Set([
  "185.220.101.1",
  "45.95.147.10"
]);

// Suspicious User-Agent fragments
const suspiciousAgents = [
  "headless",
  "selenium",
  "phantom",
  "crawler",
  "bot"
];

/* =========================================================
   IP REPUTATION
========================================================= */

function checkIpReputation(ip) {
  if (!ip) {
    return { score: 20, flagged: false, reason: "No IP" };
  }

  if (knownBadIps.has(ip)) {
    return { score: 80, flagged: true, reason: "Known malicious IP" };
  }

  if (ip.startsWith("127.") || ip === "::1") {
    return { score: 0, flagged: false, reason: "Localhost" };
  }

  return { score: 5, flagged: false, reason: "Unknown IP" };
}

/* =========================================================
   USER AGENT ANALYSIS
========================================================= */

function analyzeUserAgent(userAgent) {
  const ua = normalize(userAgent);

  if (!ua) {
    return { score: 30, flagged: true, reason: "Missing UA" };
  }

  for (const fragment of suspiciousAgents) {
    if (ua.includes(fragment)) {
      return {
        score: 50,
        flagged: true,
        reason: `Suspicious agent: ${fragment}`
      };
    }
  }

  return { score: 5, flagged: false, reason: "Normal UA" };
}

/* =========================================================
   DEVICE FINGERPRINT CORRELATION
========================================================= */

function correlateFingerprint(current, previous) {
  if (!previous) {
    return { score: 10, changed: false };
  }

  if (current !== previous) {
    return { score: 40, changed: true };
  }

  return { score: 0, changed: false };
}

/* =========================================================
   BEHAVIORAL SIGNALS
========================================================= */

function behaviorSignals({
  failedLogins = 0,
  rapidRequests = false
}) {
  let score = 0;

  if (failedLogins >= 3) score += 25;
  if (failedLogins >= 5) score += 40;
  if (rapidRequests) score += 30;

  return { score };
}

/* =========================================================
   THREAT AGGREGATOR
========================================================= */

function evaluateThreat({
  ip,
  userAgent,
  fingerprint,
  previousFingerprint,
  failedLogins = 0,
  rapidRequests = false
}) {
  try {
    const ipResult = checkIpReputation(ip);
    const uaResult = analyzeUserAgent(userAgent);
    const fpResult = correlateFingerprint(
      fingerprint,
      previousFingerprint
    );
    const behaviorResult = behaviorSignals({
      failedLogins,
      rapidRequests
    });

    let totalScore =
      ipResult.score +
      uaResult.score +
      fpResult.score +
      behaviorResult.score;

    totalScore = clamp(totalScore, 0, 100);

    let level = "Low";
    if (totalScore >= 70) level = "Critical";
    else if (totalScore >= 45) level = "High";
    else if (totalScore >= 25) level = "Medium";

    return {
      threatScore: totalScore,
      level,
      flags: {
        ip: ipResult.flagged,
        userAgent: uaResult.flagged,
        fingerprintChanged: fpResult.changed
      },
      reasons: [
        ipResult.reason,
        uaResult.reason
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
