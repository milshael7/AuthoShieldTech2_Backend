// backend/src/users/user.service.js
// Enterprise User Service — Roles + Subscription + Admin Bootstrap
// + Autodev 6.5 Capability Extension (Safe Upgrade)

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readDb, updateDb } = require("../lib/db");

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

function nowIso() {
  return new Date().toISOString();
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeId(prefix = "usr") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

/* =========================================================
   ACCOUNT TYPE RESOLUTION (Autodev Logic)
========================================================= */

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
  if (!password || String(password).length < 6)
    throw new Error("Password too short");

  const exists = findByEmail(e);
  if (exists) throw new Error("Email already exists");

  const passwordHash = await bcrypt.hash(String(password), 10);

  const accountType = resolveAccountType(role);

  const user = {
    id: makeId(),
    email: e,
    role,
    accountType,
    companyId,

    // 🔥 Autodev 6.5 Capability Fields
    freedomEnabled: false,        // seat upgrade flag
    autoprotectEnabled: false,    // Autodev 6.5 toggle
    managedCompanies: [],         // companies under protection scope

    locked: false,
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

  return safeUser(user);
}

async function verifyPassword(user, password) {
  if (!user?.passwordHash) return false;
  return bcrypt.compare(String(password || ""), user.passwordHash);
}

function setSubscriptionStatus(userId, subscriptionStatus) {
  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];
    const u = db.users.find((x) => String(x.id) === String(userId));
    if (!u) return db;
    u.subscriptionStatus = subscriptionStatus;
    u.updatedAt = nowIso();
    return db;
  });
}

function setApprovalStatus(userId, status) {
  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];
    const u = db.users.find((x) => String(x.id) === String(userId));
    if (!u) return db;
    u.status = status;
    u.updatedAt = nowIso();
    return db;
  });
}

/* =========================================================
   AUTODEV 6.5 CONTROL METHODS
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

  if (!email || !password) {
    return;
  }

  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];

    const existing = db.users.find((u) => normEmail(u.email) === email);
    if (existing) return db;

    const passwordHash = bcrypt.hashSync(password, 10);

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

      locked: false,
      subscriptionStatus: SUBSCRIPTION.ACTIVE,
      status: APPROVAL_STATUS.APPROVED,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    return db;
  });
}

module.exports = {
  ROLES,
  SUBSCRIPTION,
  APPROVAL_STATUS,

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
