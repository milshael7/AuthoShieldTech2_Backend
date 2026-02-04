// backend/src/services/posture.service.js
// =====================================================
// SECURITY POSTURE ENGINE (FINAL MVP)
// -----------------------------------------------------
// Purpose:
// - Power cybersecurity rooms (Individual / Company / Manager)
// - Match visual dashboard structure (EDR, ITDR, EMAIL, DATA, SAT, DARK WEB)
// - Provide SAFE, stable data for frontend rendering
// - NO secrets, NO raw logs, NO vendor keys
// =====================================================

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowISO() {
  return new Date().toISOString();
}

// -----------------------------------------------------
// Core module definitions (MATCHES YOUR IMAGE)
// -----------------------------------------------------
const MODULES = [
  { id: 'EDR', label: 'EDR', description: 'Endpoint Detection & Response' },
  { id: 'ITDR', label: 'ITDR', description: 'Identity Threat Detection & Response' },
  { id: 'EMAIL', label: 'Email', description: 'Email Security & Phishing Defense' },
  { id: 'DATA', label: 'Data', description: 'Data Loss & Data Security' },
  { id: 'SAT', label: 'SAT', description: 'Security Awareness Training' },
  { id: 'DARK_WEB', label: 'Dark Web', description: 'Dark Web Monitoring' }
];

// -----------------------------------------------------
// Generate module posture (safe + consistent)
// -----------------------------------------------------
function buildModulePosture({ enabled = true, health = 80 }) {
  const score = clamp(health, 0, 100);

  return {
    enabled,
    score,
    status:
      score >= 85 ? 'healthy' :
      score >= 65 ? 'warning' :
      'risk',
    lastScan: nowISO(),
    alerts: score < 70 ? 1 : 0
  };
}

// -----------------------------------------------------
// Aggregate overall posture
// -----------------------------------------------------
function calculateOverall(modules) {
  const scores = Object.values(modules).map(m => m.score);
  const avg = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    score: avg,
    risk:
      avg >= 85 ? 'low' :
      avg >= 65 ? 'medium' :
      'high'
  };
}

// -----------------------------------------------------
// Base snapshot generator
// -----------------------------------------------------
function generatePostureSnapshot({ userId, role }) {
  const modules = {};

  MODULES.forEach(mod => {
    modules[mod.id] = buildModulePosture({
      enabled: true,
      health:
        mod.id === 'DARK_WEB' ? 70 :
        mod.id === 'EMAIL' ? 75 :
        85
    });
  });

  const overall = calculateOverall(modules);

  return {
    ok: true,
    generatedAt: nowISO(),

    viewer: {
      userId,
      role
    },

    overall: {
      score: overall.score,
      risk: overall.risk,
      activeAlerts: Object.values(modules).filter(m => m.alerts > 0).length
    },

    modules,

    timeline: {
      EDR: true,
      ITDR: true,
      EMAIL: true,
      DATA: true,
      SAT: true,
      DARK_WEB: true
    },

    recent: {
      alerts: [
        {
          id: 'alert_1',
          module: 'ITDR',
          severity: 'warning',
          title: 'Unrecognized login behavior',
          message: 'New device fingerprint detected.',
          at: nowISO()
        }
      ],
      events: []
    }
  };
}

// -----------------------------------------------------
// PUBLIC EXPORTS (USED BY ROUTES)
// -----------------------------------------------------

function getMyPosture({ user }) {
  return generatePostureSnapshot({
    userId: user?.id || user?._id || 'unknown',
    role: user?.role || 'Individual'
  });
}

function getCompanyPosture({ user }) {
  const snapshot = generatePostureSnapshot({
    userId: user?.companyId || user?.id || 'unknown',
    role: 'Company'
  });

  snapshot.company = {
    users: 12,
    protectedEndpoints: 18,
    domains: 3
  };

  return snapshot;
}

function getManagerPosture({ user }) {
  const snapshot = generatePostureSnapshot({
    userId: user?.id || 'unknown',
    role: 'Manager'
  });

  snapshot.manager = {
    companies: 3,
    users: 42,
    totalAlerts: 6,
    unresolved: 2
  };

  return snapshot;
}

module.exports = {
  getMyPosture,
  getCompanyPosture,
  getManagerPosture
};
