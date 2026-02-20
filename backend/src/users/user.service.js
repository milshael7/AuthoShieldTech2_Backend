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
   AUTOPROTECT PRICING (SERVICE SCOPED)
====================================================== */

const AUTOPROTECT_PRICING = {
  automationService: 500,
  platformFee: 50,
  total: 550,
};

const AUTOPROTECT_ACTIVE_LIMIT = 10;

/* ======================================================
   BILLING VALIDATION
====================================================== */

function validateBilling(userId) {
  const db = readDb();
  const userAP = db.autoprotek?.users?.[userId];

  if (!userAP) return false;

  if (userAP.subscriptionStatus !== "ACTIVE") {
    return false;
  }

  const now = Date.now();
  const nextBilling = new Date(userAP.nextBillingDate).getTime();

  if (now > nextBilling) {
    // mark past due
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
   AUTOPROTECT ENGINE
====================================================== */

function activateAutoProtect(userId) {
  updateDb(db => {
    db.autoprotek = db.autoprotek || { users: {} };

    const nextBilling = new Date();
    nextBilling.setMonth(nextBilling.getMonth() + 1);

    db.autoprotek.users[userId] = {
      status: "ACTIVE",
      activatedAt: new Date().toISOString(),
      subscriptionStatus: "ACTIVE",
      nextBillingDate: nextBilling.toISOString(),
      pricing: AUTOPROTECT_PRICING,
      activeJobsCount: 0,
      activeJobLimit: AUTOPROTECT_ACTIVE_LIMIT,
    };
  });
}

function deactivateAutoProtect(userId) {
  updateDb(db => {
    if (!db.autoprotek?.users?.[userId]) return;

    db.autoprotek.users[userId].status = "INACTIVE";
    db.autoprotek.users[userId].subscriptionStatus = "INACTIVE";
  });
}

function isAutoProtectActive(userId) {
  if (!validateBilling(userId)) return false;

  const db = readDb();
  const userAP = db.autoprotek?.users?.[userId];

  if (!userAP) return false;
  if (userAP.status !== "ACTIVE") return false;

  return true;
}

function canRunAutoProtect(user) {
  // Admin & Manager unlimited
  if (user.role === ROLES.ADMIN || user.role === ROLES.MANAGER) {
    return true;
  }

  const db = readDb();
  const userAP = db.autoprotek?.users?.[user.id];

  if (!userAP) return false;

  // Billing enforcement
  if (!validateBilling(user.id)) {
    return false;
  }

  if (userAP.status !== "ACTIVE") return false;

  if (userAP.activeJobsCount >= AUTOPROTECT_ACTIVE_LIMIT) {
    return false;
  }

  return true;
}

function registerAutoProtectJob(user) {
  if (user.role === ROLES.ADMIN || user.role === ROLES.MANAGER) {
    return;
  }

  updateDb(db => {
    const userAP = db.autoprotek?.users?.[user.id];
    if (!userAP) return;
    if (userAP.activeJobsCount >= AUTOPROTECT_ACTIVE_LIMIT) return;

    userAP.activeJobsCount += 1;
  });
}

function closeAutoProtectJob(user) {
  updateDb(db => {
    const userAP = db.autoprotek?.users?.[user.id];
    if (!userAP) return;
    if (userAP.activeJobsCount <= 0) return;

    userAP.activeJobsCount -= 1;
  });
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
   ADMIN BOOTSTRAP
====================================================== */

function ensureAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const db = readDb();
  ensureArrays(db);

  const emailKey = normEmail(ADMIN_EMAIL);

  const exists = db.users.find(
    u => normEmail(u.email) === emailKey && u.role === ROLES.ADMIN
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
   USER CREATION
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

  if (db.users.find(u => normEmail(u.email) === normEmail(cleanEmail))) {
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

  // AutoProtect
  activateAutoProtect,
  deactivateAutoProtect,
  isAutoProtectActive,
  canRunAutoProtect,
  registerAutoProtectJob,
  closeAutoProtectJob,
};
