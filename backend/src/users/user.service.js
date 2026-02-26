// backend/src/users/user.service.js
// Enterprise User Authority Service — Hardened v2.1
// Anti-Escalation • Audited • Subscription Safe • Tenant Validated
// Adds: seat/freedom helpers for tool-request routing

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

/* ========================================================= */

const ROLES = Object.freeze({
  ADMIN: "Admin",
  FINANCE: "Finance",
  MANAGER: "Manager",
  COMPANY: "Company",
  SMALL_COMPANY: "Small_Company",
  INDIVIDUAL: "Individual",
});

const SUBSCRIPTION = Object.freeze({
  TRIAL: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Past Due",
  LOCKED: "Locked",
});

const APPROVAL_STATUS = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
});

const ROLE_VALUES = Object.values(ROLES);
const SUB_VALUES = Object.values(SUBSCRIPTION);
const APPROVAL_VALUES = Object.values(APPROVAL_STATUS);

/* ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeId(prefix = "usr") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function resolveAccountType(role) {
  switch (role) {
    case ROLES.ADMIN:
      return "admin";
    case ROLES.MANAGER:
      return "manager";
    case ROLES.COMPANY:
    case ROLES.SMALL_COMPANY:
      return "company";
    case ROLES.INDIVIDUAL:
      return "single";
    default:
      return "seat";
  }
}

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

/* =========================================================
   ROLE / SEAT / FREEDOM HELPERS (USED BY ROUTES)
========================================================= */

/**
 * Seat = user is tied to a company AND does not have freedom.
 * This matches your rule: seat requests go to company first.
 */
function isSeatUser(u) {
  return Boolean(u?.companyId) && !Boolean(u?.freedomEnabled);
}

/**
 * Freedom = user can act independently (direct tool request allowed).
 */
function hasFreedom(u) {
  return Boolean(u?.freedomEnabled);
}

function isAdmin(u) {
  return String(u?.role) === ROLES.ADMIN;
}

function isManager(u) {
  return String(u?.role) === ROLES.MANAGER;
}

function isCompany(u) {
  return String(u?.role) === ROLES.COMPANY || String(u?.role) === ROLES.SMALL_COMPANY;
}

function isIndividual(u) {
  return String(u?.role) === ROLES.INDIVIDUAL;
}

/* =========================================================
   VALIDATION HELPERS
========================================================= */

function validateRole(role) {
  if (!ROLE_VALUES.includes(role)) {
    throw new Error("Invalid role");
  }
}

function validateSubscription(status) {
  if (!SUB_VALUES.includes(status)) {
    throw new Error("Invalid subscription status");
  }
}

function validateApprovalStatus(status) {
  if (!APPROVAL_VALUES.includes(status)) {
    throw new Error("Invalid approval status");
  }
}

function validateCompany(companyId) {
  if (!companyId) return;

  const db = readDb();
  const exists = (db.companies || []).some(
    (c) => String(c.id) === String(companyId)
  );

  if (!exists) {
    throw new Error("Invalid company reference");
  }
}

/* =========================================================
   CRUD
========================================================= */

function listUsers() {
  const db = readDb();
  return (db.users || []).map(safeUser);
}

function findById(id) {
  const db = readDb();
  return (db.users || []).find((u) => String(u.id) === String(id)) || null;
}

function findByEmail(email) {
  const db = readDb();
  const e = normEmail(email);
  return (db.users || []).find((u) => normEmail(u.email) === e) || null;
}

/* =========================================================
   CREATE USER (NO ADMIN ESCALATION)
========================================================= */

async function createUser({
  email,
  password,
  role = ROLES.INDIVIDUAL,
  companyId = null,
  subscriptionStatus = SUBSCRIPTION.TRIAL,
  status = APPROVAL_STATUS.PENDING,
}) {
  const e = normEmail(email);
  if (!e) throw new Error("Email required");
  if (!password || String(password).length < 8)
    throw new Error("Password too short");

  validateRole(role);
  validateSubscription(subscriptionStatus);
  validateApprovalStatus(status);
  validateCompany(companyId);

  if (role === ROLES.ADMIN) {
    throw new Error("Admin creation not allowed here");
  }

  const exists = findByEmail(e);
  if (exists) throw new Error("Email already exists");

  const passwordHash = await bcrypt.hash(String(password), 12);

  const user = {
    id: makeId(),
    email: e,
    role,
    accountType: resolveAccountType(role),
    companyId,

    freedomEnabled: false,
    autoprotectEnabled: false,
    managedCompanies: [],

    securityFlags: {},

    locked: subscriptionStatus === SUBSCRIPTION.LOCKED,
    subscriptionStatus,
    status,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];
    db.users.push({ ...user, passwordHash });
    return db;
  });

  audit({
    actor: "system",
    role: "system",
    action: "USER_CREATED",
    target: user.id,
  });

  return safeUser(user);
}

/* =========================================================
   PASSWORD VERIFY
========================================================= */

async function verifyPassword(user, password) {
  if (!user?.passwordHash) return false;
  return bcrypt.compare(String(password || ""), user.passwordHash);
}

/* =========================================================
   MUTATION METHODS (AUDITED)
========================================================= */

function setSubscriptionStatus(userId, subscriptionStatus) {
  validateSubscription(subscriptionStatus);

  updateDb((db) => {
    const u = db.users.find((x) => String(x.id) === String(userId));
    if (!u) return db;

    u.subscriptionStatus = subscriptionStatus;
    u.locked = subscriptionStatus === SUBSCRIPTION.LOCKED;
    u.updatedAt = nowIso();

    return db;
  });

  audit({
    actor: "system",
    role: "system",
    action: "SUBSCRIPTION_STATUS_CHANGED",
    target: userId,
    metadata: { subscriptionStatus },
  });
}

function setApprovalStatus(userId, status) {
  validateApprovalStatus(status);

  updateDb((db) => {
    const u = db.users.find((x) => String(x.id) === String(userId));
    if (!u) return db;

    u.status = status;
    u.updatedAt = nowIso();
    return db;
  });

  audit({
    actor: "system",
    role: "system",
    action: "APPROVAL_STATUS_CHANGED",
    target: userId,
    metadata: { status },
  });
}

/* =========================================================
   AUTODEV CONTROL (VALIDATED)
========================================================= */

function setFreedom(userId, enabled) {
  updateDb((db) => {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return db;

    u.freedomEnabled = !!enabled;
    u.updatedAt = nowIso();
    return db;
  });
}

function setAutoProtect(userId, enabled) {
  updateDb((db) => {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return db;

    u.autoprotectEnabled = !!enabled;
    u.updatedAt = nowIso();
    return db;
  });
}

function attachCompany(userId, companyId) {
  validateCompany(companyId);

  updateDb((db) => {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return db;

    if (!Array.isArray(u.managedCompanies)) {
      u.managedCompanies = [];
    }

    if (!u.managedCompanies.includes(companyId)) {
      u.managedCompanies.push(companyId);
    }

    u.updatedAt = nowIso();
    return db;
  });
}

/* =========================================================
   ADMIN BOOTSTRAP
========================================================= */

function ensureAdminFromEnv() {
  const email = normEmail(process.env.ADMIN_EMAIL || "");
  const password = String(process.env.ADMIN_PASSWORD || "");

  if (!email || !password) return;

  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];

    const existing = db.users.find((u) => normEmail(u.email) === email);
    if (existing) return db;

    const passwordHash = bcrypt.hashSync(password, 12);

    db.users.push({
      id: makeId("admin"),
      email,
      passwordHash,
      role: ROLES.ADMIN,
      accountType: "admin",
      companyId: null,

      freedomEnabled: true,
      autoprotectEnabled: false,
      managedCompanies: [],
      securityFlags: {},

      locked: false,
      subscriptionStatus: SUBSCRIPTION.ACTIVE,
      status: APPROVAL_STATUS.APPROVED,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    return db;
  });
}

/* ========================================================= */

module.exports = {
  ROLES,
  SUBSCRIPTION,
  APPROVAL_STATUS,

  // helpers (important for tool request logic)
  isSeatUser,
  hasFreedom,
  isAdmin,
  isManager,
  isCompany,
  isIndividual,

  listUsers,
  findById,
  findByEmail,
  createUser,
  verifyPassword,

  setSubscriptionStatus,
  setApprovalStatus,

  setFreedom,
  setAutoProtect,
  attachCompany,

  ensureAdminFromEnv,
};
