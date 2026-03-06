// =========================================================
// AUTOSHIELD — ADMIN COMPATIBILITY ROUTES v1 (SEALED)
// PURPOSE:
// - Prevent 404-based ZeroTrust kickouts for Admin UI
// - Provide GLOBAL READ access for dashboards & rooms
// - NO SECURITY AUTHORITY
// - NO STATE MUTATION (except safe company create)
// - QUIET • DETERMINISTIC • ADMIN ONLY
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

/* ================= HELPERS ================= */

function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

function requireAdmin(req, res, next) {
  if (normalize(req.user?.role) !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

/* ================= MIDDLEWARE ================= */

router.use(authRequired);
router.use(requireAdmin);

/* =========================================================
   ADMIN — USERS (GLOBAL VIEW)
   Frontend: api.adminUsers()
========================================================= */

router.get("/users", (req, res) => {
  try {
    const db = readDb();

    return res.json(
      (db.users || []).map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        companyId: u.companyId || null,
        subscriptionStatus: u.subscriptionStatus || "inactive",
        autoprotectEnabled: Boolean(u.autoprotectEnabled)
      }))
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   ADMIN — COMPANIES (GLOBAL VIEW)
   Frontend: api.adminCompanies()
========================================================= */

router.get("/companies", (req, res) => {
  try {
    const db = readDb();
    return res.json(db.companies || []);
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   ADMIN — CREATE COMPANY (SAFE)
========================================================= */

router.post("/companies", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ ok: false });
    }

    const db = readDb();

    const company = {
      id: `comp_${Date.now()}`,
      name,
      createdAt: new Date().toISOString(),
      subscriptionStatus: "active",
      subscriptionTier: "free"
    };

    db.companies = db.companies || [];
    db.companies.push(company);
    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ADMIN_COMPANY_CREATED",
      detail: { companyId: company.id }
    });

    return res.json({ ok: true, company });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ADMIN — NOTIFICATIONS (GLOBAL)
   Frontend: api.adminNotifications()
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const db = readDb();
    return res.json(db.notifications || []);
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   MANAGER ROOM — OVERVIEW (ADMIN VIEW)
   Frontend: api.managerOverview()
========================================================= */

router.get("/manager/overview", (req, res) => {
  try {
    const db = readDb();

    return res.json({
      users: (db.users || []).length,
      companies: (db.companies || []).length,
      auditEvents: (db.auditLog || []).length,
      notifications: (db.notifications || []).length
    });
  } catch {
    return res.json(null);
  }
});

/* =========================================================
   MANAGER ROOM — AUDIT (ADMIN VIEW)
   Frontend: api.managerAudit(limit)
========================================================= */

router.get("/manager/audit", (req, res) => {
  try {
    const limit = Math.min(
      500,
      Math.max(1, Number(req.query.limit) || 100)
    );

    const db = readDb();
    const audit = db.auditLog || [];

    return res.json(
      audit
        .slice()
        .reverse()
        .slice(0, limit)
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   MANAGER ROOM — NOTIFICATIONS (ADMIN VIEW)
   Frontend: api.managerNotifications()
========================================================= */

router.get("/manager/notifications", (req, res) => {
  try {
    const db = readDb();
    return res.json(db.notifications || []);
  } catch {
    return res.json([]);
  }
});

module.exports = router;
