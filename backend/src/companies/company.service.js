// backend/src/companies/company.service.js
const { nanoid } = require("nanoid");
const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");

/* =========================================================
   TIER CONFIG (USER LIMIT BASED)
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

function ensureCompanies(db) {
  if (!Array.isArray(db.companies)) db.companies = [];
}

function safeStr(v, maxLen = 160) {
  const s = String(v || "").trim();
  return s ? s.slice(0, maxLen) : "";
}

function nowISO() {
  return new Date().toISOString();
}

function getCompanyById(db, id) {
  ensureCompanies(db);
  const cid = String(id || "").trim();
  if (!cid) return null;
  return db.companies.find((c) => String(c.id) === cid) || null;
}

function enforceUserLimit(company) {
  const tier = normalizeTier(company.tier);
  const limit = TIERS[tier].maxUsers;

  if (!Array.isArray(company.members)) company.members = [];

  if (company.members.length >= limit) {
    throw new Error(
      "User limit reached for current plan. Please upgrade."
    );
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
    createdBy: createdBy ? String(createdBy) : null,
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
   UPGRADE COMPANY
========================================================= */

function upgradeCompany(companyId, newTier, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  const normalizedTier = normalizeTier(newTier);

  c.tier = normalizedTier;
  c.maxUsers = TIERS[normalizedTier].maxUsers;

  writeDb(db);

  audit({
    actorId: actorId ? String(actorId) : null,
    action: "COMPANY_UPGRADED",
    targetType: "Company",
    targetId: c.id,
    metadata: { newTier: normalizedTier },
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

/* =========================================================
   MEMBER MANAGEMENT
========================================================= */

function addMember(companyId, userId, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing userId");

  if (!Array.isArray(c.members)) c.members = [];

  // Enforce user limit BEFORE adding
  enforceUserLimit(c);

  if (!c.members.map(String).includes(uid)) {
    c.members.push(uid);
    writeDb(db);

    audit({
      actorId: actorId ? String(actorId) : null,
      action: "COMPANY_ADD_MEMBER",
      targetType: "Company",
      targetId: c.id,
      metadata: { userId: uid },
    });

    createNotification({
      companyId: c.id,
      severity: "info",
      title: "Member added",
      message: `User ${uid} was added to company.`,
    });
  }

  return c;
}

function removeMember(companyId, userId, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error("Company not found");

  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing userId");

  if (!Array.isArray(c.members)) c.members = [];

  const before = c.members.length;
  c.members = c.members.filter((x) => String(x) !== uid);

  if (c.members.length !== before) {
    writeDb(db);

    audit({
      actorId: actorId ? String(actorId) : null,
      action: "COMPANY_REMOVE_MEMBER",
      targetType: "Company",
      targetId: c.id,
      metadata: { userId: uid },
    });

    createNotification({
      companyId: c.id,
      severity: "warn",
      title: "Member removed",
      message: `User ${uid} was removed from company.`,
    });
  }

  return c;
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  TIERS,
  createCompany,
  upgradeCompany,
  listCompanies,
  getCompany,
  addMember,
  removeMember,
};
