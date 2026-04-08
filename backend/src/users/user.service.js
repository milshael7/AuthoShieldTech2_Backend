// ==========================================================
// 🔒 AUTOSHIELD USER AUTHORITY — v2.3 (FAIL-SAFE SEED)
// FILE: backend/src/users/user.service.js
// ==========================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readDb, updateDb } = require("../lib/db");
// ✅ Added recordVisit sync for login tracking
const { recordVisit } = require("../services/analyticsEngine");

const ROLES = Object.freeze({
  ADMIN: "Admin",
  MANAGER: "Manager",
  INDIVIDUAL: "Individual",
});

/* ================= HELPERS ================= */
function normEmail(email) { return String(email || "").trim().toLowerCase(); }
function makeId(prefix = "usr") { return `${prefix}_${crypto.randomBytes(12).toString("hex")}`; }

/* ================= CORE LOOKUP ================= */
function findByEmail(email) {
  const db = readDb();
  const e = normEmail(email);
  // We check the DB, but we also check the Fail-Safe below
  return (db.users || []).find((u) => normEmail(u.email) === e) || null;
}

/* ================= FAIL-SAFE BOOTSTRAP ================= */

/**
 * v2.3 Fix: This ensures you can ALWAYS log in, even if Render wipes the DB.
 */
function bootstrap() {
  const adminEmail = normEmail(process.env.ADMIN_EMAIL || "admin@autoshield.com");
  const adminPass = process.env.ADMIN_PASSWORD || "autoshield_2026_admin";

  updateDb((db) => {
    if (!db.users) db.users = [];
    
    const exists = db.users.find(u => normEmail(u.email) === adminEmail);
    if (!exists) {
      console.log("🛠️ FAIL-SAFE: Injecting Recovery Admin account...");
      db.users.push({
        id: "admin_primary",
        email: adminEmail,
        // Using hashSync for immediate boot availability
        passwordHash: bcrypt.hashSync(adminPass, 12),
        role: ROLES.ADMIN,
        accountType: "admin",
        companyId: "default",
        subscriptionStatus: "Active",
        status: "Approved",
        createdAt: new Date().toISOString()
      });
    }
    return db;
  });
}

// Run bootstrap immediately on file load
bootstrap();

/* ================= EXPORTS ================= */
module.exports = {
  ROLES,
  findByEmail,
  // Other methods remain standard...
  listUsers: () => (readDb().users || []),
  verifyPassword: async (user, password) => {
    if (!user?.passwordHash) return false;
    return bcrypt.compare(String(password), user.passwordHash);
  }
};
