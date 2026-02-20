// backend/src/companies/company.service.js
// Company Service — Tier Enforced • Billing Safe • Enterprise Hardened

const { nanoid } = require("nanoid");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");

/* =========================================================
   TIER CONFIG (SYNCED WITH BILLING)
========================================================= */

const TIERS = {
  micro: { maxUsers: 5 },
  small: { maxUsers: 15 },
  mid: { maxUsers: 50 },
  enterprise: { maxUsers: 150 },
};

const VALID_TIERS = Object.keys(TIERS);

function normalizeTier(tier) {
  const t = String(tier || "").toLowerCase();
  if (!VALID_TIERS.includes(t)) {
    throw new Error("Invalid tier");
  }
  return t;
}

/* =========================================================
   HELPERS
========================================================= */

function ensureCompanies(db) {
  if (!Array.isArray(db.companies)) db.companies = [];
}

function safeStr(v, maxLen = 160) {
  return String(v || "").trim().slice(0, maxLen);
}

function nowISO() {
  return new Date().toISOString();
}

function getCompanyById(db, id) {
  ensureCompanies(db);
  return db.companies.find((c) => c.id === id) || null;
}

function normalizeMembers(company) {
  if (!Array.isArray(company.members)) company.members = [];

  company.members = company.members.map((m) => {
    if (typeof m === "string") {
      return {
        userId: m,
        position: "member",
        assignedAt: nowISO(),
        assignedBy: null,
      };
    }
    return m;
  });
}

function enforceUserLimit(company) {
  normalizeMembers(company);

  const limit = TIERS[company.tier].maxUsers;

  if (company.members.length >= limit) {
    throw new Error(
      "User limit reached for current plan. Please upgrade."
    );
  }
}

function evaluateRestriction(company) {
  normalizeMembers(company);

  const limit = TIERS[company.tier].maxUsers;

  company.isOverLimit = company.members.length > limit;

  if (company.isOverLimit) {
    company.status = "Restricted";
  } else {
    company.status = "Active";
  }
}

/* =========================================================
   CREATE COMPANY
========================================================= */

function createCompany({
  name,
  country,
  website,
  industry,
  contactEmail,
  contactPhone,
  tier = "micro",
  createdBy,
}) {
  const db = readDb();
  ensureCompanies(db);

  const cleanName = safeStr(name, 120);
  if (!cleanName) throw new Error("Company name required");

  const normalizedTier = normalizeTier(tier);

  const c = {
    id: nanoid(),
    name: cleanName,
    country: safeStr(country, 80),
    website: safeStr(website, 160),
    industry: safeStr(industry, 120),
    contactEmail: safeStr(contactEmail, 160),
    contactPhone: safeStr(contactPhone, 60),
    tier: normalizedTier,
    maxUsers: TIERS[normalizedTier].maxUsers,
    createdAt: nowISO(),
    status: "Active",
    isOverLimit: false,
    createdBy: createdBy || null,
    members: [],
  };

  db.companies.push(c);
  writeDb(db);

  audit({
    actorId: c.createdBy,
    action: "COMPANY_CREATED",
    targetType: "Company",
    targetId: c.id,
  });

  createNotification({
    companyId: c.id,
    severity: "info",
    title: "Company created",
    message: "Company workspace is ready.",
  });

  return c;
}

/* =========================================================
   UPGRADE / DOWNGRADE
========================================================= */

function upgradeCompany(companyId, newTier, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  const normalizedTier = normalizeTier(newTier);

  const oldTier = c.tier;

  c.tier = normalizedTier;
  c.maxUsers = TIERS[normalizedTier].maxUsers;

  evaluateRestriction(c);

  writeDb(db);

  audit({
    actorId: actorId || null,
    action: "COMPANY_TIER_CHANGED",
    targetType: "Company",
    targetId: c.id,
    metadata: {
      oldTier,
      newTier: normalizedTier,
      isOverLimit: c.isOverLimit,
    },
  });

  if (c.isOverLimit) {
    createNotification({
      companyId: c.id,
      severity: "warn",
      title: "Plan downgrade restriction",
      message:
        "Member count exceeds current plan limit. Remove users or upgrade.",
    });
  }

  return c;
}

/* =========================================================
   MEMBER MANAGEMENT
========================================================= */

function addMember(companyId, userId, actorId, position = "member") {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  normalizeMembers(c);
  enforceUserLimit(c);

  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing userId");

  const exists = c.members.find(
    (m) => String(m.userId) === uid
  );

  if (!exists) {
    c.members.push({
      userId: uid,
      position: safeStr(position, 80) || "member",
      assignedAt: nowISO(),
      assignedBy: actorId || null,
    });

    evaluateRestriction(c);
    writeDb(db);

    audit({
      actorId: actorId || null,
      action: "COMPANY_ADD_MEMBER",
      targetType: "Company",
      targetId: c.id,
      metadata: { userId: uid },
    });
  }

  return c;
}

function removeMember(companyId, userId, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  normalizeMembers(c);

  c.members = c.members.filter(
    (m) => String(m.userId) !== String(userId)
  );

  evaluateRestriction(c);
  writeDb(db);

  audit({
    actorId: actorId || null,
    action: "COMPANY_REMOVE_MEMBER",
    targetType: "Company",
    targetId: c.id,
    metadata: { userId },
  });

  return c;
}

/* =========================================================
   LIST / GET
========================================================= */

function listCompanies() {
  const db = readDb();
  ensureCompanies(db);
  return db.companies;
}

function getCompany(id) {
  const db = readDb();
  return getCompanyById(db, id);
}

module.exports = {
  TIERS,
  VALID_TIERS,
  createCompany,
  upgradeCompany,
  listCompanies,
  getCompany,
  addMember,
  removeMember,
};
