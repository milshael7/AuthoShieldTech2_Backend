// backend/src/users/user.service.js
// Phase 27 — Enterprise User Service
// Role Separation • Finance Governance • Field-Level Masking • Exposure Control

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
  FINANCE: "Finance",
};

const ROLE_ALLOWLIST = Object.values(ROLES);

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
   HELPERS
====================================================== */

function ensureArrays(db) {
  if (!Array.isArray(db.users)) db.users = [];
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateRole(role) {
  if (!ROLE_ALLOWLIST.includes(role)) {
    throw new Error("Invalid role assignment");
  }
}

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

/* ======================================================
   FIELD-LEVEL MASKING ENGINE
====================================================== */

function maskUserForRole(user, accessTier) {
  if (!user) return null;

  const base = {
    id: user.id,
    platformId: user.platformId,
    role: user.role,
    companyId: user.companyId,
    subscriptionStatus: user.subscriptionStatus,
    createdAt: user.createdAt,
  };

  // ADMIN → full visibility (except passwordHash)
  if (accessTier === "ADMIN") {
    return {
      ...base,
      email: user.email,
      status: user.status,
      approvedBy: user.approvedBy,
      trialStartAt: user.trialStartAt,
      trialExpiresAt: user.trialExpiresAt,
      profile: user.profile || {},
    };
  }

  // FINANCE → see email + billing state, but not approval metadata
  if (accessTier === "FINANCE") {
    return {
      ...base,
      email: user.email,
      subscriptionStatus: user.subscriptionStatus,
      profile: {},
    };
  }

  // MANAGER → limited internal visibility
  if (accessTier === "MANAGER") {
    return {
      ...base,
      email: maskEmail(user.email),
      subscriptionStatus: user.subscriptionStatus,
    };
  }

  // STANDARD → strict masking
  return {
    id: user.id,
    email: maskEmail(user.email),
    role: user.role,
    subscriptionStatus: user.subscriptionStatus,
  };
}

function listUsersForAccess(accessContext) {
  const db = readDb();
  ensureArrays(db);

  const tier = accessContext?.tier || "STANDARD";

  return db.users.map((u) =>
    maskUserForRole(u, tier)
  );
}

/* ======================================================
   USER CREATION
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  validateRole(role);

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

  if (db.users.find(u => normEmail(u.email) === normEmail(cleanEmail))) {
    throw new Error("Email already exists");
  }

  if (!password || String(password).length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const now = new Date();

  const user = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role,
    companyId,
    createdAt: now.toISOString(),
    subscriptionStatus: SUBSCRIPTION.TRIAL,
    trialStartAt: now.toISOString(),
    trialExpiresAt: null,
    locked: false,
    status: APPROVAL_STATUS.PENDING,
    approvedBy: null,
    profile: typeof profile === "object" ? profile : {},
  };

  db.users.push(user);
  writeDb(db);

  return maskUserForRole(user, "ADMIN");
}

/* ======================================================
   QUERIES
====================================================== */

function findByEmail(email) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find(u => normEmail(u.email) === normEmail(email)) || null;
}

function findById(id) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find(u => u.id === id) || null;
}

function listUsers() {
  const db = readDb();
  ensureArrays(db);
  return db.users.map(u => {
    const { passwordHash, ...safe } = u;
    return safe;
  });
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
  createUser,
  findByEmail,
  findById,
  listUsers,
  listUsersForAccess,
  maskUserForRole,
  verifyPassword,
};
