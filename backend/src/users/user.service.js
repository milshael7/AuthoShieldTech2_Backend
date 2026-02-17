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
   AUTOPROTECT
====================================================== */

function getAutoprotect(u) {
  return !!(u?.autoprotectEnabled ?? u?.autoprotechEnabled);
}

function setAutoprotect(u, enabled) {
  const val = !!enabled;
  u.autoprotectEnabled = val;
  u.autoprotechEnabled = val;
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
    profile: { displayName: "Admin" },
  };

  setAutoprotect(admin, true);

  db.users.push(admin);
  writeDb(db);

  audit({
    actorId: admin.id,
    actorRole: admin.role,
    action: "ADMIN_BOOTSTRAP",
    target: admin.id,
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

  const r = requireValidRole(role);

  if (db.users.find((u) => normEmail(u.email) === normEmail(cleanEmail))) {
    throw new Error("Email already exists");
  }

  if (!password || String(password).length < 4) {
    throw new Error("Password too short");
  }

  const isIndividual = r === ROLES.INDIVIDUAL;

  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: r,
    companyId: companyId || null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: isIndividual
      ? SUBSCRIPTION.TRIAL
      : SUBSCRIPTION.ACTIVE,
    trialEndsAt: isIndividual
      ? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      : null,
    mustResetPassword: false,
    profile: typeof profile === "object" ? profile : {},
    locked: false,
  };

  setAutoprotect(u, r === ROLES.ADMIN || r === ROLES.MANAGER);

  db.users.push(u);
  writeDb(db);

  audit({
    actorId: u.id,
    actorRole: u.role,
    action: "USER_CREATED",
    target: u.id,
  });

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
   UPDATE (HARDENED)
====================================================== */

function updateUser(id, patch, actorId, actorRole = ROLES.ADMIN) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  const p = patch && typeof patch === "object" ? { ...patch } : {};

  // Prevent privilege escalation
  if (typeof p.role !== "undefined") {
    const newRole = requireValidRole(p.role);
    requireRoleAuthority(actorRole, u.role);
    p.role = newRole;
  }

  if (typeof p.autoprotectEnabled !== "undefined") {
    setAutoprotect(u, p.autoprotectEnabled);
    delete p.autoprotectEnabled;
    delete p.autoprotechEnabled;
  }

  Object.assign(u, p);
  writeDb(db);

  audit({
    actorId,
    actorRole,
    action: "USER_UPDATED",
    target: id,
  });

  return sanitize(u);
}

/* ======================================================
   LOCK / SUSPEND
====================================================== */

function suspendUser(id, actorId, actorRole) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  requireRoleAuthority(actorRole, u.role);

  u.locked = true;
  u.subscriptionStatus = SUBSCRIPTION.LOCKED;

  writeDb(db);

  audit({
    actorId,
    actorRole,
    action: "USER_SUSPENDED",
    target: id,
  });

  return sanitize(u);
}

/* ======================================================
   PASSWORD / SECURITY
====================================================== */

function rotatePlatformIdAndForceReset(id, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  u.platformId = `AS-${nanoid(10).toUpperCase()}`;
  u.mustResetPassword = true;

  writeDb(db);

  audit({
    actorId,
    actorRole: "system",
    action: "USER_ROTATE_ID",
    target: id,
  });

  return sanitize(u);
}

function setPassword(id, newPassword, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error("User not found");

  if (!newPassword || String(newPassword).length < 4) {
    throw new Error("Password too short");
  }

  u.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  u.mustResetPassword = false;

  writeDb(db);

  audit({
    actorId,
    actorRole: "system",
    action: "USER_PASSWORD_SET",
    target: id,
  });

  return sanitize(u);
}

function verifyPassword(user, password) {
  if (!user) return false;

  if (user.locked || user.subscriptionStatus === SUBSCRIPTION.LOCKED) {
    throw new Error("Account locked");
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
  ensureAdminFromEnv,
  createUser,
  findByEmail,
  listUsers,
  updateUser,
  suspendUser,
  rotatePlatformIdAndForceReset,
  setPassword,
  verifyPassword,
  getAutoprotect,
};
