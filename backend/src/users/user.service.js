// ==========================================================
// 🔒 AUTOSHIELD USER AUTHORITY — v2.2 (RENDER-PERSISTENT)
// FILE: backend/src/users/user.service.js
// ==========================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

// Connect to Analytics for "Lively" growth tracking
const { recordVisit } = require("../services/analyticsEngine");

/* ================= CONSTANTS ================= */

const ROLES = Object.freeze({
  ADMIN: "Admin",
  FINANCE: "Finance",
  MANAGER: "Manager",
  COMPANY: "Company",
  SMALL_COMPANY: "Small_Company",
  INDIVIDUAL: "Individual",
});

const SUBSCRIPTION = Object.freeze({
  TRIAL: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Past Due",
  LOCKED: "Locked",
});

const APPROVAL_STATUS = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
});

const ROLE_VALUES = Object.values(ROLES);
const SUB_VALUES = Object.values(SUBSCRIPTION);
const APPROVAL_VALUES = Object.values(APPROVAL_STATUS);

/* ================= HELPERS ================= */

function nowIso() { return new Date().toISOString(); }
function normEmail(email) { return String(email || "").trim().toLowerCase(); }
function makeId(prefix = "usr") { return `${prefix}_${crypto.randomBytes(12).toString("hex")}`; }

function resolveAccountType(role) {
  switch (role) {
    case ROLES.ADMIN: return "admin";
    case ROLES.MANAGER: return "manager";
    case ROLES.COMPANY:
    case ROLES.SMALL_COMPANY: return "company";
    case ROLES.INDIVIDUAL: return "single";
    default: return "seat";
  }
}

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// Seat/Freedom Helpers
const isSeatUser = (u) => Boolean(u?.companyId) && !Boolean(u?.freedomEnabled);
const hasFreedom = (u) => Boolean(u?.freedomEnabled);
const isAdmin = (u) => String(u?.role) === ROLES.ADMIN;
const isManager = (u) => String(u?.role) === ROLES.MANAGER;
const isCompany = (u) => String(u?.role) === ROLES.COMPANY || String(u?.role) === ROLES.SMALL_COMPANY;
const isIndividual = (u) => String(u?.role) === ROLES.INDIVIDUAL;

/* ================= CRUD ================= */

function listUsers() {
  const db = readDb();
  return (db.users || []).map(safeUser);
}

function findById(id) {
  const db = readDb();
  return (db.users || []).find((u) => String(u.id) === String(id)) || null;
}

function findByEmail(email) {
  const db = readDb();
  const e = normEmail(email);
  return (db.users || []).find((u) => normEmail(u.email) === e) || null;
}

/* ================= CREATE USER ================= */

async function createUser({
  email,
  password,
  role = ROLES.INDIVIDUAL,
  companyId = null,
  subscriptionStatus = SUBSCRIPTION.TRIAL,
  status = APPROVAL_STATUS.PENDING,
}) {
  const e = normEmail(email);
  if (!e) throw new Error("Email required");
  if (!password || String(password).length < 8) throw new Error("Password too short");

  if (role === ROLES.ADMIN) throw new Error("Admin creation not allowed here");
  
  const exists = findByEmail(e);
  if (exists) throw new Error("Email already exists");

  const passwordHash = await bcrypt.hash(String(password), 12);

  const user = {
    id: makeId(),
    email: e,
    role,
    accountType: resolveAccountType(role),
    companyId,
    freedomEnabled: false,
    autoprotectEnabled: false,
    managedCompanies: [],
    securityFlags: { failedLogins: 0 },
    locked: subscriptionStatus === SUBSCRIPTION.LOCKED,
    subscriptionStatus,
    status,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];
    db.users.push({ ...user, passwordHash });
    return db;
  });

  // RECORD IN LIVELY ANALYTICS
  recordVisit({ type: "USER_REGISTERED", path: "/signup", source: "system", tenantId: user.id });

  audit({ actor: "system", role: "system", action: "USER_CREATED", target: user.id });

  return safeUser(user);
}

/* ================= PASSWORD VERIFY ================= */

async function verifyPassword(user, password) {
  if (!user?.passwordHash) return false;
  return bcrypt.compare(String(password || ""), user.passwordHash);
}

/* ================= RENDER BOOTSTRAP (THE FIX) ================= */

/**
 * This function ensures that if Render wipes your file, your 
 * Admin account is re-created instantly from Environment Variables.
 */
function ensureAdminFromEnv() {
  const email = normEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("⚠️ RENDER_WATCH: No ADMIN_EMAIL/PASSWORD in environment.");
    return;
  }

  updateDb((db) => {
    db.users = Array.isArray(db.users) ? db.users : [];
    const existing = db.users.find((u) => normEmail(u.email) === email);
    
    if (existing) {
      console.log("✅ RENDER_WATCH: Admin User verified.");
      return db;
    }

    console.log("🚀 RENDER_WATCH: File reset detected. Re-building Admin account...");
    const passwordHash = bcrypt.hashSync(password, 12);

    db.users.push({
      id: makeId("admin"),
      email,
      passwordHash,
      role: ROLES.ADMIN,
      accountType: "admin",
      companyId: null,
      freedomEnabled: true,
      autoprotectEnabled: true,
      managedCompanies: [],
      securityFlags: { failedLogins: 0 },
      locked: false,
      subscriptionStatus: SUBSCRIPTION.ACTIVE,
      status: APPROVAL_STATUS.APPROVED,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    return db;
  });
}

/* ================= EXPORTS ================= */

module.exports = {
  ROLES,
  SUBSCRIPTION,
  APPROVAL_STATUS,
  isSeatUser,
  hasFreedom,
  isAdmin,
  isManager,
  isCompany,
  isIndividual,
  listUsers,
  findById,
  findByEmail,
  createUser,
  verifyPassword,
  ensureAdminFromEnv, // EXPORTED TO SERVER.JS
};
