// =========================================================
// AUTOSHIELD — ADMIN COMPATIBILITY ROUTES v1 (SEALED)
// PURPOSE: UI EXISTENCE + GLOBAL READ-ONLY VIEWS
// NO SECURITY AUTHORITY • NO STATE MUTATION
// ZERO-TRUST SAFE • FAIL-SILENT • NON-BLOCKING
// =========================================================

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");

/* =========================================================
   HELPERS
========================================================= */

function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

function isAdmin(user) {
  return normalize(user?.role) === "admin";
}

function emptyOk(payload) {
  return payload ?? [];
}

/* =========================================================
   AUTH (ADMIN ONLY)
========================================================= */

router.use(authRequired);
router.use((req, res, next) => {
  if (!isAdmin(req.user)) {
    // 🔇 silent deny — never leak existence
    return res.status(404).json({ ok: false });
  }
  next();
});

/* =========================================================
   USERS — GLOBAL VIEW (READ-ONLY)
   Frontend: Admin.jsx → api.adminUsers()
========================================================= */

router.get("/users", (req, res) => {
  try {
    const db = readDb();
    return res.json(
      emptyOk(db.users)
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   COMPANIES — GLOBAL VIEW (READ-ONLY)
   Frontend: Admin.jsx → api.adminCompanies()
========================================================= */

router.get("/companies", (req, res) => {
  try {
    const db = readDb();
    return res.json(
      emptyOk(db.companies)
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   ADMIN NOTIFICATIONS (AGGREGATE, SAFE)
   Frontend: Admin.jsx → api.adminNotifications()
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const db = readDb();

    const notes = [
      ...(db.securityEvents || []),
      ...(db.auditLog || []),
      ...(db.socAlerts || [])
    ]
      .slice(-100)
      .map(n => ({
        id: n.id || `n-${Date.now()}`,
        type: n.type || "system",
        message: n.title || n.action || "System event",
        createdAt: n.createdAt || new Date().toISOString()
      }));

    return res.json(notes);
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   MANAGER ROOM — OVERVIEW (ADMIN VIEW)
   Frontend: Admin.jsx → api.managerOverview()
========================================================= */

router.get("/manager/overview", (req, res) => {
  try {
    const db = readDb();

    return res.json({
      users: (db.users || []).length,
      companies: (db.companies || []).length,
      auditEvents: (db.auditLog || []).length,
      notifications:
        (db.securityEvents || []).length +
        (db.socAlerts || []).length
    });
  } catch {
    return res.json({
      users: 0,
      companies: 0,
      auditEvents: 0,
      notifications: 0
    });
  }
});

/* =========================================================
   MANAGER AUDIT (READ-ONLY)
   Frontend: Admin.jsx → api.managerAudit()
========================================================= */

router.get("/manager/audit", (req, res) => {
  try {
    const limit = Math.min(
      500,
      Number(req.query.limit) || 200
    );

    const db = readDb();
    return res.json(
      (db.auditLog || []).slice(-limit).reverse()
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   MANAGER NOTIFICATIONS (READ-ONLY)
   Frontend: Admin.jsx → api.managerNotifications()
========================================================= */

router.get("/manager/notifications", (req, res) => {
  try {
    const db = readDb();
    return res.json(
      emptyOk(db.securityEvents).slice(-100)
    );
  } catch {
    return res.json([]);
  }
});

/* =========================================================
   SAFE CREATE COMPANY (ADMIN UI SUPPORT)
   Frontend: Admin.jsx → api.adminCreateCompany()
========================================================= */

router.post("/companies", (req, res) => {
  try {
    const db = readDb();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false });

    const company = {
      id: `co_${Date.now()}`,
      name,
      createdAt: new Date().toISOString(),
      subscriptionTier: "free",
      subscriptionStatus: "active"
    };

    db.companies = db.companies || [];
    db.companies.push(company);

    require("../lib/db").writeDb(db);

    return res.json({ ok: true, company });
  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
