// backend/src/companies/company.service.js
const { nanoid } = require('nanoid');
const { readDb, writeDb } = require('../lib/db');
const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

function ensureCompanies(db) {
  if (!db.companies) db.companies = [];
  if (!Array.isArray(db.companies)) db.companies = [];
}

function safeStr(v, maxLen = 160) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function nowISO() {
  return new Date().toISOString();
}

function getCompanyById(db, id) {
  ensureCompanies(db);
  const cid = String(id || '').trim();
  if (!cid) return null;
  return db.companies.find(c => String(c.id) === cid) || null;
}

function createCompany({
  name,
  country,
  website,
  industry,
  contactEmail,
  contactPhone,
  sizeTier = 'Small',
  createdBy
}) {
  const db = readDb();
  ensureCompanies(db);

  const cleanName = safeStr(name, 120);
  if (!cleanName) throw new Error('Company name is required');

  const c = {
    id: nanoid(),
    name: cleanName,
    country: safeStr(country, 80),
    website: safeStr(website, 160),
    industry: safeStr(industry, 120),
    contactEmail: safeStr(contactEmail, 160),
    contactPhone: safeStr(contactPhone, 60),
    sizeTier: safeStr(sizeTier, 30) || 'Small',
    createdAt: nowISO(),
    status: 'Active',
    createdBy: createdBy ? String(createdBy) : null,
    members: []
  };

  db.companies.push(c);
  writeDb(db);

  audit({
    actorId: c.createdBy,
    action: 'COMPANY_CREATED',
    targetType: 'Company',
    targetId: c.id
  });

  createNotification({
    companyId: c.id,
    severity: 'info',
    title: 'Company created',
    message: 'Company workspace is ready.'
  });

  return c;
}

function listCompanies() {
  const db = readDb();
  ensureCompanies(db);
  return db.companies;
}

function getCompany(id) {
  const db = readDb();
  return getCompanyById(db, id);
}

function addMember(companyId, userId, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error('Company not found');

  const uid = String(userId || '').trim();
  if (!uid) throw new Error('Missing userId');

  if (!Array.isArray(c.members)) c.members = [];

  // prevent duplicates (string compare)
  if (!c.members.map(String).includes(uid)) {
    c.members.push(uid);
    writeDb(db);

    audit({
      actorId: actorId ? String(actorId) : null,
      action: 'COMPANY_ADD_MEMBER',
      targetType: 'Company',
      targetId: c.id,
      metadata: { userId: uid }
    });

    createNotification({
      companyId: c.id,
      severity: 'info',
      title: 'Member added',
      message: `User ${uid} was added to company.`
    });
  }

  return c;
}

function removeMember(companyId, userId, actorId) {
  const db = readDb();
  ensureCompanies(db);

  const c = getCompanyById(db, companyId);
  if (!c) throw new Error('Company not found');

  const uid = String(userId || '').trim();
  if (!uid) throw new Error('Missing userId');

  if (!Array.isArray(c.members)) c.members = [];

  const before = c.members.length;
  c.members = c.members.filter(x => String(x) !== uid);

  if (c.members.length !== before) {
    writeDb(db);

    audit({
      actorId: actorId ? String(actorId) : null,
      action: 'COMPANY_REMOVE_MEMBER',
      targetType: 'Company',
      targetId: c.id,
      metadata: { userId: uid }
    });

    createNotification({
      companyId: c.id,
      severity: 'warn',
      title: 'Member removed',
      message: `User ${uid} was removed from company.`
    });
  }

  return c;
}

module.exports = {
  createCompany,
  listCompanies,
  getCompany,
  addMember,
  removeMember
};
