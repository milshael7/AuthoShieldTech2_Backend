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
   AUTOPROTECT CONTROL (10 JOB HARD LIMIT)
====================================================== */

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function activateAutoProtect(userId) {
  updateDb((db) => {
    db.autoprotek = db.autoprotek || { users: {} };

    db.autoprotek.users[userId] = db.autoprotek.users[userId] || {
      status: "ACTIVE",
      activatedAt: new Date().toISOString(),

      // 🔒 HARD LIMIT LOCKED
      monthlyJobLimit: 10,

      jobsUsedThisMonth: 0,
      lastResetMonth: currentMonthKey(),
      companies: {},
    };

    db.autoprotek.users[userId].status = "ACTIVE";
    db.autoprotek.users[userId].monthlyJobLimit = 10;
  });
}

function deactivateAutoProtect(userId) {
  updateDb((db) => {
    if (!db.autoprotek?.users?.[userId]) return;
    db.autoprotek.users[userId].status = "INACTIVE";
  });
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

  if (userAP.jobsUsedThisMonth >= 10) {
    return false;
  }

  return true;
}

function registerAutoProtectJob(userId) {
  updateDb((db) => {
    const userAP = db.autoprotek?.users?.[userId];
    if (!userAP) return;

    if (userAP.jobsUsedThisMonth >= 10) return;

    userAP.jobsUsedThisMonth += 1;
  });
}

/* ======================================================
   USER CREATION
====================================================== */

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();

  const cleanEmail = String(email || "").trim();
  if (!cleanEmail) throw new Error("Email required");

  if (db.users.find((u) => u.email.toLowerCase() === cleanEmail.toLowerCase())) {
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

  return u;
}

/* ======================================================
   QUERIES
====================================================== */

function findByEmail(email) {
  const db = readDb();
  return db.users.find(
    (u) => u.email.toLowerCase() === String(email).toLowerCase()
  ) || null;
}

function findById(id) {
  const db = readDb();
  return db.users.find((u) => u.id === id) || null;
}

function listUsers() {
  const db = readDb();
  return db.users.map((u) => {
    const { passwordHash, ...rest } = u;
    return rest;
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
  verifyPassword,

  activateAutoProtect,
  deactivateAutoProtect,
  canRunAutoProtect,
  registerAutoProtectJob,
};
