// backend/src/lib/tools.engine.js
// Enterprise Tools Engine Core
// Centralized access control + catalog logic
// Used by routes layer (tools.routes.js)

/*
   ROLE MODEL (from user.service):
   ADMIN
   MANAGER
   COMPANY
   SMALL_COMPANY
   INDIVIDUAL

   SUBSCRIPTION:
   TRIAL
   ACTIVE
   PAST_DUE
   LOCKED
*/

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

function isSubscriptionActive(user, SUBSCRIPTION) {
  return user?.subscriptionStatus === SUBSCRIPTION.ACTIVE;
}

/* =========================================================
   TOOL ACCESS CORE LOGIC
========================================================= */

function canAccessTool(user, tool, ROLES, SUBSCRIPTION) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  // ADMIN — unlimited
  if (isAdmin(user, ROLES)) {
    return tool.adminAllowed !== false;
  }

  // MANAGER — high-level access
  if (isManager(user, ROLES)) {
    if (tool.enterpriseOnly) {
      return tool.managerAllowed === true;
    }
    return tool.managerAllowed !== false;
  }

  // COMPANY — business/security only if allowed
  if (isCompany(user, ROLES)) {
    return tool.companyAllowed === true;
  }

  // INDIVIDUAL
  if (isIndividual(user, ROLES)) {
    if (tool.tier === "free") return true;

    if (
      tool.tier === "paid" &&
      isSubscriptionActive(user, SUBSCRIPTION)
    ) {
      return true;
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
      companyAllowed: false, // per your rule
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
