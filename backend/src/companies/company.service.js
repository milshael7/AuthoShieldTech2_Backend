// backend/src/companies/company.service.js

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
  const tier = normalizeTier(company.tier);
  const limit = TIERS[tier].maxUsers;

  normalizeMembers(company);

  if (company.members.length >= limit) {
    throw new Error(
      "User limit reached for current plan. Please upgrade."
    );
  }
}

function evaluateRestriction(company) {
  const tier = normalizeTier(company.tier);
  const limit = TIERS[tier].maxUsers;

  normalizeMembers(company);

  if (company.members.length > limit) {
    company.status = "Restricted";
  } else if (company.status === "Restricted") {
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
   UPGRADE / DOWNGRADE COMPANY
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
    actorId: actorId ? String(actorId) : null,
    action: "COMPANY_TIER_CHANGED",
    targetType: "Company",
    targetId: c.id,
    metadata: {
      oldTier,
      newTier: normalizedTier,
      status: c.status,
    },
  });

  if (c.status === "Restricted") {
    createNotification({
      companyId: c.id,
      severity: "warn",
      title: "Company restricted",
      message:
        "Member count exceeds new plan limit. Remove extra users or upgrade.",
    });
  }

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
      assignedBy: actorId ? String(actorId) : null,
    });

    evaluateRestriction(c);
    writeDb(db);

    audit({
      actorId: actorId ? String(actorId) : null,
      action: "COMPANY_ADD_MEMBER",
      targetType: "Company",
      targetId: c.id,
      metadata: { userId: uid, position },
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

  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing userId");

  c.members = c.members.filter(
    (m) => String(m.userId) !== uid
  );

  evaluateRestriction(c);
  writeDb(db);

  audit({
    actorId: actorId ? String(actorId) : null,
    action: "COMPANY_REMOVE_MEMBER",
    targetType: "Company",
    targetId: c.id,
    metadata: { userId: uid },
  });

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
