const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { readDb, writeDb, writeAudit: audit } = require("../lib/db");
const { createNotification } = require("../lib/notify");

/* ======================================================
   CONSTANTS
====================================================== */

const ROLES = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  COMPANY: "Company",
  INDIVIDUAL: "Individual",
};

const ROLE_RANK = {
  [ROLES.ADMIN]: 4,
  [ROLES.MANAGER]: 3,
  [ROLES.COMPANY]: 2,
  [ROLES.INDIVIDUAL]: 1,
};

const SUBSCRIPTION = {
  TRIAL: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "PastDue",
  LOCKED: "Locked",
};

const APPROVAL_STATUS = {
  PENDING: "pending",
  MANAGER_APPROVED: "manager_approved",
  APPROVED: "approved",
  DENIED: "denied",
};

/* ======================================================
   INTERNAL HELPERS
====================================================== */

function ensureArrays(db) {
  if (!Array.isArray(db.users)) db.users = [];
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sanitize(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function requireValidRole(role) {
  const r = String(role || "").trim();
  if (!Object.values(ROLES).includes(r)) {
    throw new Error(`Invalid role: ${r}`);
  }
  return r;
}

function requireRoleAuthority(actorRole, targetRole) {
  const actorRank = ROLE_RANK[actorRole] || 0;
  const targetRank = ROLE_RANK[targetRole] || 0;

  if (actorRank <= targetRank) {
    throw new Error("Insufficient authority for this action");
  }
}

/* ======================================================
   ADMIN BOOTSTRAP
====================================================== */

function ensureAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const db = readDb();
  ensureArrays(db);

  const emailKey = normEmail(ADMIN_EMAIL);

  const exists = db.users.find(
    (u) => normEmail(u.email) === emailKey && u.role === ROLES.ADMIN
  );

  if (exists) return;

  const admin = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: ADMIN_EMAIL.trim(),
    passwordHash: bcrypt.hashSync(String(ADMIN_PASSWORD), 10),
    role: ROLES.ADMIN,
    companyId: null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: SUBSCRIPTION.ACTIVE,
    mustResetPassword: false,
    locked: false,

    status: APPROVAL_STATUS.APPROVED,
    approvedBy: "system",
  };

  db.users.push(admin);
  writeDb(db);
}

/* ======================================================
   USER CREATION (NOW PENDING BY DEFAULT)
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

  const r = requireValidRole(role);

  if (db.users.find((u) => normEmail(u.email) === normEmail(cleanEmail))) {
    throw new Error("Email already exists");
  }

  if (!password || String(password).length < 4) {
    throw new Error("Password too short");
  }

  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: r,
    companyId: companyId || null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: SUBSCRIPTION.TRIAL,
    mustResetPassword: false,
    locked: false,

    status: APPROVAL_STATUS.PENDING,
    approvedBy: null,
    profile: typeof profile === "object" ? profile : {},
  };

  db.users.push(u);
  writeDb(db);

  return sanitize(u);
}

/* ======================================================
   APPROVAL SYSTEM
====================================================== */

function listPendingUsers() {
  const db = readDb();
  ensureArrays(db);
  return db.users
    .filter((u) => u.status === APPROVAL_STATUS.PENDING)
    .map(sanitize);
}

function managerApproveUser(id, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  if (u.status !== APPROVAL_STATUS.PENDING) {
    throw new Error("User not pending");
  }

  u.status = APPROVAL_STATUS.MANAGER_APPROVED;
  u.approvedBy = "manager";

  writeDb(db);
  return sanitize(u);
}

function adminApproveUser(id, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  u.status = APPROVAL_STATUS.APPROVED;
  u.approvedBy = "admin";

  writeDb(db);
  return sanitize(u);
}

function adminDenyUser(id, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  u.status = APPROVAL_STATUS.DENIED;
  u.locked = true;

  writeDb(db);
  return sanitize(u);
}

/* ======================================================
   QUERIES
====================================================== */

function findByEmail(email) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find((u) => normEmail(u.email) === normEmail(email)) || null;
}

function listUsers() {
  const db = readDb();
  ensureArrays(db);
  return db.users.map(sanitize);
}

/* ======================================================
   PASSWORD VERIFY (LOGIN ENFORCEMENT)
====================================================== */

function verifyPassword(user, password) {
  if (!user) return false;

  if (user.locked) throw new Error("Account locked");

  if (user.status !== APPROVAL_STATUS.APPROVED) {
    throw new Error("Account not approved");
  }

  return bcrypt.compareSync(
    String(password || ""),
    String(user.passwordHash || "")
  );
}

/* ======================================================
   EXPORT
====================================================== */

module.exports = {
  ROLES,
  SUBSCRIPTION,
  APPROVAL_STATUS,
  ensureAdminFromEnv,
  createUser,
  listPendingUsers,
  managerApproveUser,
  adminApproveUser,
  adminDenyUser,
  findByEmail,
  listUsers,
  verifyPassword,
};
