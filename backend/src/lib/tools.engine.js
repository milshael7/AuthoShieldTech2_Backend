// backend/src/lib/tools.engine.js
// Enterprise Tools Engine Core
// v3 — Hardened Governance Alignment
// Entitlement + Role + Seat Governance Logic
// Approval timing/grants enforced in routes/tools.routes.js

const { userHasTool } = require("./entitlement.engine");

/* =========================================================
   HELPERS
========================================================= */

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

function isAdmin(user, ROLES) {
  return user?.role === ROLES.ADMIN;
}

function isManager(user, ROLES) {
  return user?.role === ROLES.MANAGER;
}

function isCompany(user, ROLES) {
  return (
    user?.role === ROLES.COMPANY ||
    user?.role === ROLES.SMALL_COMPANY
  );
}

function isIndividual(user, ROLES) {
  return user?.role === ROLES.INDIVIDUAL;
}

/**
 * Seat user = tied to company AND no freedom
 */
function isSeatUser(user) {
  return Boolean(user?.companyId) && !Boolean(user?.freedomEnabled);
}

/* =========================================================
   CORE ACCESS DECISION
   This answers:
   "Is this user ever allowed to use or request this tool?"
   (NOT time-limited approval logic — that's in routes)
========================================================= */

function canAccessTool(user, tool, ROLES) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  /* ===============================
     ADMIN — FULL OVERRIDE
  =============================== */
  if (isAdmin(user, ROLES)) {
    return tool.adminAllowed !== false;
  }

  /* ===============================
     MANAGER
  =============================== */
  if (isManager(user, ROLES)) {
    if (tool.enterpriseOnly) {
      return tool.managerAllowed === true;
    }
    return tool.managerAllowed !== false;
  }

  /* ===============================
     COMPANY
  =============================== */
  if (isCompany(user, ROLES)) {
    return tool.companyAllowed === true;
  }

  /* ===============================
     INDIVIDUAL (Standalone)
  =============================== */
  if (isIndividual(user, ROLES) && !isSeatUser(user)) {
    if (tool.tier === "free") return true;

    if (tool.tier === "paid" || tool.tier === "enterprise") {
      return userHasTool(user, tool.id);
    }

    return false;
  }

  /* ===============================
     SEAT USER (Under Company)
     🔒 Cannot escalate beyond company policy
  =============================== */
  if (isSeatUser(user)) {
    // If company does not allow this tool at all → deny
    if (tool.companyAllowed !== true) return false;

    // Free tools allowed
    if (tool.tier === "free") return true;

    // Paid/enterprise tools require entitlement
    if (tool.tier === "paid" || tool.tier === "enterprise") {
      return userHasTool(user, tool.id);
    }

    return false;
  }

  return false;
}

/* =========================================================
   DEFAULT TOOL SEED
   Includes approval/dangerous metadata
========================================================= */

function seedToolsIfEmpty(db) {
  db.tools = normalizeArray(db.tools);

  if (db.tools.length > 0) return false;

  db.tools = [
    {
      id: "vuln-scan",
      name: "Vulnerability Scanner",
      description: "Baseline vulnerability discovery.",
      tier: "free",
      category: "security",
      enabled: true,

      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: true,

      requiresApproval: false,
      dangerous: false,
    },
    {
      id: "threat-intel",
      name: "Threat Intelligence AI",
      description: "AI-driven threat mapping and enrichment.",
      tier: "paid",
      category: "security",
      enabled: true,

      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: true,

      requiresApproval: false,
      dangerous: false,
    },
    {
      id: "autodev-65",
      name: "Autodev 6.5",
      description: "Automated defense system engine.",
      tier: "paid",
      category: "automation",
      enabled: true,

      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: false,

      requiresApproval: true,
      dangerous: false,
      maxDurationMinutes: 1440, // 1 day cap
    },
    {
      id: "enterprise-radar",
      name: "Enterprise Global Radar",
      description: "Global monitoring + response control.",
      tier: "enterprise",
      category: "enterprise",
      enabled: true,

      enterpriseOnly: true,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: false,

      requiresApproval: true,
      dangerous: true,
      maxDurationMinutes: 2880, // 2 day cap
    },
    {
      id: "forensics-shell",
      name: "Forensics Shell (Restricted)",
      description: "Restricted investigation shell. Admin supervised only.",
      tier: "enterprise",
      category: "restricted",
      enabled: false,

      enterpriseOnly: true,
      adminAllowed: true,
      managerAllowed: false,
      companyAllowed: false,

      requiresApproval: true,
      dangerous: true,
      maxDurationMinutes: 120,
    },
  ];

  return true;
}

module.exports = {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray,
};
