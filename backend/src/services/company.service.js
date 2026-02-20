const { nanoid } = require("nanoid");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");

/* =========================================================
   TIER CONFIG
========================================================= */

const TIERS = {
  micro: { maxUsers: 5 },
  small: { maxUsers: 15 },
  mid: { maxUsers: 50 },
  enterprise: { maxUsers: 150 },
  unlimited: { maxUsers: Infinity },
};

function normalizeTier(tier) {
  const t = String(tier || "").toLowerCase();
  return TIERS[t] ? t : "micro";
}

/* =========================================================
   HELPERS
========================================================= */

function safeStr(v, max = 160) {
  return String(v || "").trim().slice(0, max);
}

function nowISO() {
  return new Date().toISOString();
}

function ensureCompanies(db) {
  if (!Array.isArray(db.companies)) db.companies = [];
}

function getCompanyById(db, id) {
  ensureCompanies(db);
  const cid = safeStr(id, 100);
  if (!cid) return null;
  return db.companies.find((c) => c.id === cid) || null;
}

function getUserById(db, userId) {
  return (db.users || []).find((u) => u.id === userId) || null;
}

function enforceUserLimit(company) {
  const tier = normalizeTier(company.tier);
  const limit = TIERS[tier].maxUsers;

  if (!Array.isArray(company.members)) company.members = [];

  if (company.members.length >= limit) {
    throw new Error("User limit reached for current plan. Upgrade required.");
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
  if (!cleanName) throw new Error("Company name is required");

  const normalizedTier = normalizeTier(tier);

  const company = {
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
    createdBy: createdBy ? String(createdBy) : null,

    members: [],
  };

  db.companies.push(company);
  writeDb(db);

  audit({
    actorId: createdBy || "system",
    action: "COMPANY_CREATED",
    targetType: "Company",
    targetId: company.id,
  });

  createNotification({
    companyId: company.id,
    severity: "info",
    title: "Company created",
    message: "Company workspace is ready.",
  });

  return company;
}

/* =========================================================
   UPGRADE COMPANY
========================================================= */

function upgradeCompany(companyId, newTier, actorId) {
  const db = readDb();
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error("Company not found");

  const normalizedTier = normalizeTier(newTier);

  company.tier = normalizedTier;
  company.maxUsers = TIERS[normalizedTier].maxUsers;

  writeDb(db);

  audit({
    actorId,
    action: "COMPANY_UPGRADED",
    targetType: "Company",
    targetId: company.id,
    metadata: { newTier: normalizedTier },
  });

  return company;
}

/* =========================================================
   ADD MEMBER (HARDENED)
========================================================= */

function addMember(companyId, userId, actorId, position = "member") {
  const db = readDb();
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error("Company not found");

  const user = getUserById(db, userId);
  if (!user) throw new Error("User not found");

  // Prevent cross-company membership
  if (user.companyId && user.companyId !== company.id) {
    throw new Error("User already belongs to another company");
  }

  if (!Array.isArray(company.members)) company.members = [];

  const exists = company.members.find(
    (m) => m.userId === userId
  );

  if (exists) return company;

  enforceUserLimit(company);

  company.members.push({
    userId,
    position: safeStr(position, 80) || "member",
    assignedAt: nowISO(),
  });

  user.companyId = company.id;

  writeDb(db);

  audit({
    actorId,
    action: "COMPANY_ADD_MEMBER",
    targetType: "Company",
    targetId: company.id,
    metadata: { userId },
  });

  createNotification({
    companyId: company.id,
    severity: "info",
    title: "Member added",
    message: `User ${userId} added.`,
  });

  return company;
}

/* =========================================================
   REMOVE MEMBER
========================================================= */

function removeMember(companyId, userId, actorId) {
  const db = readDb();
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error("Company not found");

  const user = getUserById(db, userId);
  if (!user) throw new Error("User not found");

  const before = company.members.length;

  company.members = company.members.filter(
    (m) => m.userId !== userId
  );

  if (company.members.length !== before) {
    user.companyId = null;

    writeDb(db);

    audit({
      actorId,
      action: "COMPANY_REMOVE_MEMBER",
      targetType: "Company",
      targetId: company.id,
      metadata: { userId },
    });

    createNotification({
      companyId: company.id,
      severity: "warn",
      title: "Member removed",
      message: `User ${userId} removed.`,
    });
  }

  return company;
}

/* =========================================================
   EXPORTS
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
  createCompany,
  upgradeCompany,
  listCompanies,
  getCompany,
  addMember,
  removeMember,
};
