const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { readDb, writeDb } = require("../lib/db");

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
   COMPANY BRANCH REGISTRY
====================================================== */

const BRANCHES = [
  "soc",
  "analyst",
  "consultant",
  "incident_response",
  "compliance",
  "threat_intel",
  "vulnerability",
  "forensics",
];

function validateBranch(branch) {
  const b = String(branch || "").toLowerCase().trim();
  if (!BRANCHES.includes(b)) {
    throw new Error("Invalid branch");
  }
  return b;
}

/* ======================================================
   HELPERS
====================================================== */

function ensureArrays(db) {
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.approvals)) db.approvals = [];
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

function requireAuthority(actorRole, targetRole) {
  const actorRank = ROLE_RANK[actorRole] || 0;
  const targetRank = ROLE_RANK[targetRole] || 0;

  if (actorRank <= targetRank) {
    throw new Error("Insufficient authority");
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
    branch: null,
  };

  db.users.push(admin);
  writeDb(db);
}

/* ======================================================
   USER CREATION
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

  if (!password || String(password).length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: r,
    companyId: companyId || null,
    branch: null, // NEW
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
   BRANCH ASSIGNMENT
====================================================== */

function assignBranch(userId, branch, actorRole) {
  const db = readDb();
  ensureArrays(db);

  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new Error("User not found");

  requireAuthority(actorRole, user.role);

  user.branch = validateBranch(branch);

  writeDb(db);
  return sanitize(user);
}

function removeBranch(userId, actorRole) {
  const db = readDb();
  ensureArrays(db);

  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new Error("User not found");

  requireAuthority(actorRole, user.role);

  user.branch = null;

  writeDb(db);
  return sanitize(user);
}

/* ======================================================
   QUERIES
====================================================== */

function findByEmail(email) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find((u) => normEmail(u.email) === normEmail(email)) || null;
}

function findById(id) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find((u) => u.id === id) || null;
}

function listUsers() {
  const db = readDb();
  ensureArrays(db);
  return db.users.map(sanitize);
}

function verifyPassword(user, password) {
  if (!user) return false;
  if (user.locked) throw new Error("Account locked");
  if (user.status !== APPROVAL_STATUS.APPROVED)
    throw new Error("Account not approved");

  return bcrypt.compareSync(password, user.passwordHash);
}

module.exports = {
  ROLES,
  SUBSCRIPTION,
  APPROVAL_STATUS,
  BRANCHES,
  ensureAdminFromEnv,
  createUser,
  assignBranch,
  removeBranch,
  findByEmail,
  findById,
  listUsers,
  verifyPassword,
};
