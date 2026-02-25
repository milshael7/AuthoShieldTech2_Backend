// backend/src/lib/tools.engine.js
// Enterprise Tools Engine Core
// Entitlement-based access control (billing-ready)

const {
  userHasTool
} = require("./entitlement.engine");

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

/* =========================================================
   TOOL ACCESS CORE LOGIC (ENTITLEMENT DRIVEN)
========================================================= */

function canAccessTool(user, tool, ROLES) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  // ADMIN — full override
  if (isAdmin(user, ROLES)) {
    return tool.adminAllowed !== false;
  }

  // MANAGER — full operational access
  if (isManager(user, ROLES)) {
    if (tool.enterpriseOnly) {
      return tool.managerAllowed === true;
    }
    return tool.managerAllowed !== false;
  }

  // COMPANY — only explicitly allowed tools
  if (isCompany(user, ROLES)) {
    return tool.companyAllowed === true;
  }

  // INDIVIDUAL — entitlement required for paid/enterprise tools
  if (isIndividual(user, ROLES)) {

    // Free tools always allowed
    if (tool.tier === "free") return true;

    // Paid or enterprise require entitlement
    if (tool.tier === "paid" || tool.tier === "enterprise") {
      return userHasTool(user, tool.id);
    }

    return false;
  }

  return false;
}

/* =========================================================
   DEFAULT TOOL SEED
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
    },
    {
      id: "threat-intel",
      name: "Threat Intelligence AI",
      description: "Advanced AI-driven threat mapping.",
      tier: "paid",
      category: "security",
      enabled: true,
      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: true,
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
    },
  ];

  return true;
}

module.exports = {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray
};
