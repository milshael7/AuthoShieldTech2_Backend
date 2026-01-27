// backend/src/services/posture.service.js
// MVP posture calculator (safe defaults)
// Later: wire to real DB/audit/incident metrics

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

/**
 * Returns a stable posture payload you can display everywhere.
 * You can later replace this with real stats:
 * - audit events
 * - incident counts
 * - risk scoring
 * - company aggregation
 */
function buildPosture({ scope = "me", actor = null } = {}) {
  // If your auth middleware sets req.user, you can use it here.
  const role = actor?.role || "User";

  // Simple “starter scoring” (not finance-related, just UI posture)
  // You will replace these with real metrics later.
  const baseScore =
    role === "Admin" ? 92 :
    role === "Manager" ? 88 :
    role === "Company" ? 84 :
    80;

  // Coverage meters (0..100)
  const coverage = {
    phishing: 88,
    malware: 76,
    accountTakeover: 91,
    fraud: 69
  };

  // Example “risk flags” that later become real alerts
  const flags = [
    { id: "mfa", title: "MFA", status: "recommended" },
    { id: "password", title: "Password Policy", status: "ok" },
    { id: "device", title: "Device Hygiene", status: "watch" },
    { id: "training", title: "Staff Training", status: "watch" },
  ];

  // Build score from coverage (keep it deterministic)
  const avg = (
    coverage.phishing +
    coverage.malware +
    coverage.accountTakeover +
    coverage.fraud
  ) / 4;

  const score = clamp(Math.round((baseScore * 0.55) + (avg * 0.45)), 0, 100);

  return {
    ok: true,
    scope,               // "me" | "company" | "manager"
    role,                // from actor if available
    score,               // 0..100
    grade:
      score >= 90 ? "Excellent" :
      score >= 80 ? "Good" :
      score >= 65 ? "Fair" : "At Risk",
    coverage,            // meters
    flags,               // checklist
    updatedAt: new Date().toISOString()
  };
}

module.exports = { buildPosture };
