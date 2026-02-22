// backend/src/users/user.service.js
// AuthoShieldTech — User Service (Hardened)
// Roles • Subscription States • Core User Access

const { readDb, updateDb } = require("../lib/db");

/* =========================================================
   ROLES
========================================================= */

const ROLES = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  COMPANY: "Company",
  SMALL_COMPANY: "Small_Company",
  INDIVIDUAL: "Individual",
  FINANCE: "Finance",
};

/* =========================================================
   SUBSCRIPTION STATES
========================================================= */

const SUBSCRIPTION = {
  ACTIVE: "Active",
  TRIAL: "Trial",
  LOCKED: "Locked",
  PAST_DUE: "Past_Due",
  CANCELED: "Canceled",
};

/* =========================================================
   HELPERS
========================================================= */

function normalizeRole(role) {
  return String(role || "").trim();
}

/* =========================================================
   USER READ
========================================================= */

function listUsers() {
  const db = readDb();
  return db.users || [];
}

function findById(id) {
  const db = readDb();
  return (db.users || []).find((u) => String(u.id) === String(id));
}

function findByEmail(email) {
  const db = readDb();
  return (db.users || []).find(
    (u) => String(u.email).toLowerCase() === String(email).toLowerCase()
  );
}

/* =========================================================
   USER WRITE
========================================================= */

function createUser(userData) {
  return updateDb((db) => {
    const newUser = {
      id: String(Date.now()),
      createdAt: new Date().toISOString(),
      role: ROLES.INDIVIDUAL,
      subscriptionStatus: SUBSCRIPTION.TRIAL,
      ...userData,
    };

    db.users.push(newUser);
    return db;
  });
}

function updateUser(id, updates) {
  return updateDb((db) => {
    const user = db.users.find((u) => String(u.id) === String(id));
    if (!user) return db;

    Object.assign(user, updates);
    user.updatedAt = new Date().toISOString();

    return db;
  });
}

/* =========================================================
   ADMIN BOOTSTRAP
========================================================= */

function ensureAdminFromEnv() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) return;

  const existing = findByEmail(email);
  if (existing) return;

  createUser({
    email,
    password,
    role: ROLES.ADMIN,
    subscriptionStatus: SUBSCRIPTION.ACTIVE,
  });

  console.log("[BOOT] Admin user ensured from ENV");
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  ROLES,
  SUBSCRIPTION,
  listUsers,
  findById,
  findByEmail,
  createUser,
  updateUser,
  ensureAdminFromEnv,
};
