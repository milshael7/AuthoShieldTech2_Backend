// backend/src/users/user.service.js
// Enterprise User Service — Governance Enabled
// Role Separation • Finance Role • Trial Safe • Billing Safe

const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { readDb, writeDb, updateDb } = require("../lib/db");

/* ======================================================
   CONSTANTS
====================================================== */

const ROLES = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  COMPANY: "Company",
  INDIVIDUAL: "Individual",
  FINANCE: "Finance", // 🔥 NEW ENTERPRISE ROLE
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
   TRIAL CONFIG
====================================================== */

const TRIAL_DURATION_DAYS = 14;
const TRIAL_GRACE_DAYS = 3;

/* ======================================================
   AUTOPROTECT CONFIG
====================================================== */

const AUTOPROTECT_PRICING = {
  automationService: 500,
  platformFee: 50,
  total: 550,
};

const AUTOPROTECT_ACTIVE_LIMIT = 10;

/* ======================================================
   HELPERS
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

function validateRole(role) {
  if (!ROLE_ALLOWLIST.includes(role)) {
    throw new Error("Invalid role assignment");
  }
}

/* ======================================================
   TRIAL ENGINE
====================================================== */

function enforceTrialIfExpired(userId) {
  const db = readDb();
  const user = db.users.find(u => u.id === userId);
  if (!user) return;

  if (user.subscriptionStatus !== SUBSCRIPTION.TRIAL) return;

  const now = Date.now();
  const expires = new Date(user.trialExpiresAt).getTime();
  const graceLimit =
    expires + TRIAL_GRACE_DAYS * 24 * 60 * 60 * 1000;

  if (now > graceLimit) {
    updateDb(db2 => {
      const u = db2.users.find(x => x.id === userId);
      if (!u) return;
      u.subscriptionStatus = SUBSCRIPTION.LOCKED;
      u.trialExpiredAt = new Date().toISOString();
    });
  }
}

function getTrialStatus(userId) {
  const db = readDb();
  const user = db.users.find(u => u.id === userId);
  if (!user || user.subscriptionStatus !== SUBSCRIPTION.TRIAL) {
    return null;
  }

  const now = Date.now();
  const expires = new Date(user.trialExpiresAt).getTime();
  const remainingMs = expires - now;

  return {
    trialStartAt: user.trialStartAt,
    trialExpiresAt: user.trialExpiresAt,
    daysRemaining: Math.max(
      0,
      Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
    ),
  };
}

/* ======================================================
   BILLING VALIDATION
====================================================== */

function validateBilling(userId) {
  enforceTrialIfExpired(userId);

  const db = readDb();
  const user = db.users.find(u => u.id === userId);
  if (!user) return false;

  if (user.subscriptionStatus === SUBSCRIPTION.TRIAL) {
    return true;
  }

  if (user.subscriptionStatus !== SUBSCRIPTION.ACTIVE) {
    return false;
  }

  const userAP = db.autoprotek?.users?.[userId];
  if (!userAP) return false;

  const now = Date.now();
  const nextBilling = new Date(userAP.nextBillingDate).getTime();

  if (now > nextBilling) {
    updateDb(db2 => {
      if (!db2.autoprotek?.users?.[userId]) return;
      db2.autoprotek.users[userId].subscriptionStatus = "PAST_DUE";
      db2.autoprotek.users[userId].status = "INACTIVE";
    });

    return false;
  }

  return true;
}

/* ======================================================
   USER CREATION
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  validateRole(role); // 🔥 ROLE SAFETY

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

  if (db.users.find(u => normEmail(u.email) === normEmail(cleanEmail))) {
    throw new Error("Email already exists");
  }

  if (!password || String(password).length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const now = new Date();
  const expires = new Date();
  expires.setDate(now.getDate() + TRIAL_DURATION_DAYS);

  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role,
    companyId: companyId || null,
    createdAt: now.toISOString(),
    subscriptionStatus: SUBSCRIPTION.TRIAL,
    trialStartAt: now.toISOString(),
    trialExpiresAt: expires.toISOString(),
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
  ensureAdminFromEnv,
  createUser,
  findByEmail,
  findById,
  listUsers,
  verifyPassword,
  getTrialStatus,
  validateBilling,
};
