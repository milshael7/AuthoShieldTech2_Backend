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
  trial: { planKey: "trial", discountPercent: 0, includedScans: 0 },
  individual: { planKey: "individual", discountPercent: 30, includedScans: 1 },
  micro: { planKey: "micro", discountPercent: 35, includedScans: 2 },
  small: { planKey: "small", discountPercent: 40, includedScans: 5 },
  mid: { planKey: "mid", discountPercent: 45, includedScans: 10 },
  enterprise: { planKey: "enterprise", discountPercent: 50, includedScans: Infinity },
};

function getUserEffectivePlan(user) {
  if (!user) return PLAN_BENEFITS.trial;

  if (user.subscriptionStatus !== SUBSCRIPTION.ACTIVE) {
    return PLAN_BENEFITS.trial;
  }

  const db = readDb();

  if (user.companyId) {
    const company = db.companies?.find((c) => c.id === user.companyId);
    if (company?.tier) {
      const tierKey = String(company.tier).toLowerCase();
      if (PLAN_BENEFITS[tierKey]) {
        return PLAN_BENEFITS[tierKey];
      }
    }
  }

  if (user.role === ROLES.INDIVIDUAL) {
    return PLAN_BENEFITS.individual;
  }

  return PLAN_BENEFITS.trial;
}

function getPlanBenefits(planKey) {
  const key = String(planKey || "").toLowerCase();
  return PLAN_BENEFITS[key] || PLAN_BENEFITS.trial;
}

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

/* ======================================================
   🔥 AUTOPROTECT CONTROL
====================================================== */

function activateAutoProtect(userId) {
  updateDb((db) => {
    db.autoprotek = db.autoprotek || { users: {} };
    db.autoprotek.users[userId] = db.autoprotek.users[userId] || {
      status: "ACTIVE",
      activatedAt: new Date().toISOString(),
      monthlyJobLimit: 30,
      jobsUsedThisMonth: 0,
      lastResetMonth: currentMonthKey(),
      companies: {},
    };

    db.autoprotek.users[userId].status = "ACTIVE";
    db.autoprotek.users[userId].activatedAt = new Date().toISOString();
  });
}

function deactivateAutoProtect(userId) {
  updateDb((db) => {
    if (!db.autoprotek?.users?.[userId]) return;
    db.autoprotek.users[userId].status = "INACTIVE";
  });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function enforceMonthlyReset(userId) {
  updateDb((db) => {
    const userAP = db.autoprotek?.users?.[userId];
    if (!userAP) return;

    const current = currentMonthKey();

    if (userAP.lastResetMonth !== current) {
      userAP.jobsUsedThisMonth = 0;
      userAP.lastResetMonth = current;
    }
  });
}

function canRunAutoProtect(userId) {
  const db = readDb();
  const userAP = db.autoprotek?.users?.[userId];

  if (!userAP) return false;
  if (userAP.status !== "ACTIVE") return false;

  enforceMonthlyReset(userId);

  if (userAP.jobsUsedThisMonth >= userAP.monthlyJobLimit) {
    return false;
  }

  return true;
}

function registerAutoProtectJob(userId) {
  updateDb((db) => {
    const userAP = db.autoprotek?.users?.[userId];
    if (!userAP) return;
    userAP.jobsUsedThisMonth += 1;
  });
}

/* ======================================================
   USER CREATION
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

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
    role,
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
  createUser,
  findByEmail,
  findById,
  listUsers,
  verifyPassword,

  // 🔥 AutoProtect exports
  activateAutoProtect,
  deactivateAutoProtect,
  canRunAutoProtect,
  registerAutoProtectJob,
};
