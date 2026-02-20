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
   PLAN ENGINE
====================================================== */

const PLAN_BENEFITS = {
  trial: {
    discountPercent: 0,
    includedScans: 0,
    label: "Trial",
  },
  individual: {
    discountPercent: 30,
    includedScans: 1,
    label: "Individual Active",
  },
  micro: {
    discountPercent: 35,
    includedScans: 2,
    label: "Micro Plan",
  },
  small: {
    discountPercent: 40,
    includedScans: 5,
    label: "Small Plan",
  },
  mid: {
    discountPercent: 45,
    includedScans: 10,
    label: "Mid Plan",
  },
  enterprise: {
    discountPercent: 50,
    includedScans: 999,
    label: "Enterprise Plan",
  },
};

function getUserEffectivePlan(user) {
  if (!user) return PLAN_BENEFITS.trial;

  if (user.subscriptionStatus !== SUBSCRIPTION.ACTIVE) {
    return PLAN_BENEFITS.trial;
  }

  const db = readDb();

  // Company plan overrides individual
  if (user.companyId) {
    const company = db.companies.find(
      (c) => c.id === user.companyId
    );

    if (company && PLAN_BENEFITS[company.tier]) {
      return PLAN_BENEFITS[company.tier];
    }
  }

  // Individual active
  if (user.role === ROLES.INDIVIDUAL) {
    return PLAN_BENEFITS.individual;
  }

  return PLAN_BENEFITS.trial;
}

function getPlanBenefits(planKey) {
  return PLAN_BENEFITS[planKey] || PLAN_BENEFITS.trial;
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
    branch: null,
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
  getUserEffectivePlan,
  getPlanBenefits,
  ensureAdminFromEnv,
  createUser,
  findByEmail,
  findById,
  listUsers,
  verifyPassword,
};
