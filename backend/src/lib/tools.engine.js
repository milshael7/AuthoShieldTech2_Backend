// backend/src/lib/tools.engine.js
// Enterprise Tools Engine Core
// Entitlement-based access control (billing-ready)
// v2: Adds support fields for approval-based tools (requiresApproval/dangerous/maxDurationMinutes)
// NOTE: Approval timing/grants are enforced in routes/tools.routes.js (not here).

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
  return user?.role === ROLES.COMPANY || user?.role === ROLES.SMALL_COMPANY;
}

function isIndividual(user, ROLES) {
  return user?.role === ROLES.INDIVIDUAL;
}

/* =========================================================
   TOOL ACCESS CORE LOGIC (ENTITLEMENT DRIVEN)
   - This answers: "Are you allowed to ever use/request this tool?"
   - Time-limited "approval/grant" enforcement happens in tools.routes.js
========================================================= */

function canAccessTool(user, tool, ROLES) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  // ADMIN — full override
  if (isAdmin(user, ROLES)) {
    return tool.adminAllowed !== false;
  }

  // MANAGER — operational access
  if (isManager(user, ROLES)) {
    if (tool.enterpriseOnly) {
      return tool.managerAllowed === true;
    }
    return tool.managerAllowed !== false;
  }

  // COMPANY (and SMALL COMPANY) — only explicitly allowed tools
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
   - We seed some tools as "requiresApproval"/"dangerous"
   - "dangerous" implies admin-only approval in tools.routes.js
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

      // approval model
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
      description: "Automated defense system engine (internal-grade).",
      tier: "paid",
      category: "automation",
      enabled: true,

      enterpriseOnly: false,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: false,

      // Autodev can be powerful; keep it approval-based if you want:
      requiresApproval: true,
      dangerous: false,
      maxDurationMinutes: 1440, // cap at 1 day even if admin tries > 1 day
    },
    {
      id: "enterprise-radar",
      name: "Enterprise Global Radar",
      description: "Global monitoring + response control (high impact).",
      tier: "enterprise",
      category: "enterprise",
      enabled: true,

      enterpriseOnly: true,
      adminAllowed: true,
      managerAllowed: true,
      companyAllowed: false,

      // admin-only approval
      requiresApproval: true,
      dangerous: true,
      maxDurationMinutes: 2880, // cap at 2 days
    },

    // Example of a tool that exists in catalog but is disabled by default
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
      maxDurationMinutes: 120, // even if enabled later, cap it hard
    },
  ];

  return true;
}

module.exports = {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray,
};
