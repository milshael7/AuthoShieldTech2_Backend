// backend/src/lib/tools.engine.js
// Enterprise Tools Engine Core
// v4 — Subscription Tier Alignment + Seat Governance Hardening
// Entitlement + Role + Seat Governance Logic
// NOTE: approval timing/grants are enforced in routes/tools.routes.js

const { userHasTool } = require("./entitlement.engine");

/* =========================================================
   HELPERS
========================================================= */

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Object.values(v);
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
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

/**
 * Seat user = tied to company AND no freedom
 * (Seat is still a user account, but governed by company)
 */
function isSeatUser(user) {
  return Boolean(user?.companyId) && !Boolean(user?.freedomEnabled);
}

function isSubscriptionLocked(user) {
  const s = norm(user?.subscriptionStatus);
  return s === "locked";
}

function safeToolTier(tool) {
  const t = norm(tool?.tier);
  if (t === "free" || t === "paid" || t === "enterprise") return t;
  return "free";
}

/**
 * Subscription tier check (billing-ready):
 * - free: can use free tools only
 * - paid: can use free + paid tools
 * - enterprise: can use free + paid + enterprise tools
 *
 * Admin/Manager bypass this gating (they already have role overrides).
 */
function tierAllowsTool(user, tool) {
  const toolTier = safeToolTier(tool);
  if (toolTier === "free") return true;

  const userTier = norm(user?.subscriptionTier || "free"); // if missing, treat as free

  if (toolTier === "paid") {
    return userTier === "paid" || userTier === "enterprise";
  }

  if (toolTier === "enterprise") {
    return userTier === "enterprise";
  }

  return false;
}

/* =========================================================
   CORE ACCESS DECISION

   This answers:
   "Is this user ever allowed to use/request this tool?"
   (NOT time-limited approval logic — that's enforced in routes)
========================================================= */

function canAccessTool(user, tool, ROLES) {
  if (!user || !tool) return false;
  if (tool.enabled === false) return false;

  // Hard stop: locked subscriptions are never allowed to use/request tools
  // (Routes also gate this, but we enforce here to keep policy consistent.)
  if (isSubscriptionLocked(user)) return false;

  /* ===============================
     ADMIN — FULL OVERRIDE
  =============================== */
  if (isAdmin(user, ROLES)) {
    return tool.adminAllowed !== false;
  }

  /* ===============================
     MANAGER — OPERATIONAL ACCESS
  =============================== */
  if (isManager(user, ROLES)) {
    if (tool.enterpriseOnly) {
      return tool.managerAllowed === true;
    }
    return tool.managerAllowed !== false;
  }

  /* ===============================
     COMPANY (and SMALL COMPANY)
     - Only explicitly allowed tools
     - Must also pass subscription tier gating
  =============================== */
  if (isCompany(user, ROLES)) {
    if (tool.companyAllowed !== true) return false;
    return tierAllowsTool(user, tool);
  }

  /* ===============================
     INDIVIDUAL (Standalone)
     - Free allowed
     - Paid/Enterprise: must pass tier gating AND have entitlement
  =============================== */
  if (isIndividual(user, ROLES) && !isSeatUser(user)) {
    if (!tierAllowsTool(user, tool)) return false;

    if (safeToolTier(tool) === "free") return true;

    // paid/enterprise require entitlement
    return userHasTool(user, tool.id);
  }

  /* ===============================
     SEAT USER (Under Company)
     🔒 Cannot escalate beyond company tool policy
     - Must be companyAllowed
     - Must pass tier gating (seat uses their own subscriptionTier unless you later switch this
       to a company-tier lookup in routes)
     - Paid/Enterprise require entitlement (billing-ready)
  =============================== */
  if (isSeatUser(user)) {
    if (tool.companyAllowed !== true) return false;
    if (!tierAllowsTool(user, tool)) return false;

    if (safeToolTier(tool) === "free") return true;

    return userHasTool(user, tool.id);
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
