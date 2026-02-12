/*
  Security Score Engine
  Enterprise Weighted Risk Model
  AutoShield Tech — Institutional Grade
*/

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

/*
  Domain Weights
  Higher = more impact on total posture
*/
const DOMAIN_WEIGHTS = {
  email: 1.2,
  endpoint: 1.3,
  awareness: 0.9,
  phishing: 1.0,
  itdr: 1.2,
  external: 1.1,
  darkweb: 1.0,
  cloud: 1.2,
  browsing: 0.8,
};

/*
  Severity Impact
*/
const SEVERITY_PENALTY = {
  low: 1,
  medium: 3,
  high: 7,
};

/*
  Tool bonus per installed module
*/
const TOOL_BONUS = 2;

function calculateSecurityScore({
  domains = [],
  events = [],
  installedTools = [],
}) {
  if (!domains.length) {
    return {
      score: 0,
      grade: "Unknown",
      risk: "Unassessed",
    };
  }

  /* ================= DOMAIN BASE ================= */

  let weightedTotal = 0;
  let totalWeight = 0;

  domains.forEach((d) => {
    const coverage = clamp(Number(d.coverage) || 0);
    const weight = DOMAIN_WEIGHTS[d.key] || 1;

    weightedTotal += coverage * weight;
    totalWeight += weight;
  });

  let baseScore = totalWeight > 0
    ? weightedTotal / totalWeight
    : 0;

  /* ================= EVENT PENALTY ================= */

  let penalty = 0;

  events.forEach((e) => {
    penalty += SEVERITY_PENALTY[e.severity] || 0;
  });

  /* ================= TOOL BONUS ================= */

  const bonus = installedTools.length * TOOL_BONUS;

  /* ================= FINAL SCORE ================= */

  let finalScore = baseScore - penalty + bonus;

  finalScore = clamp(finalScore);

  /* ================= GRADE ================= */

  let grade;
  let risk;

  if (finalScore >= 90) {
    grade = "Excellent";
    risk = "Low";
  } else if (finalScore >= 80) {
    grade = "Strong";
    risk = "Low";
  } else if (finalScore >= 65) {
    grade = "Moderate";
    risk = "Medium";
  } else if (finalScore >= 50) {
    grade = "Weak";
    risk = "Elevated";
  } else {
    grade = "Critical";
    risk = "High";
  }

  return {
    score: Math.round(finalScore),
    grade,
    risk,
    baseScore: Math.round(baseScore),
    penalty,
    bonus,
  };
}

module.exports = {
  calculateSecurityScore,
};
