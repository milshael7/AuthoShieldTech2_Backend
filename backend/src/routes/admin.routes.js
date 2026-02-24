// backend/src/routes/admin.routes.js
// Phase 32+ — Executive Finance Intelligence Layer
// + Executive Risk Index • Revenue/Refund Overlay • Predictive Churn • Subscriber Growth
// + Admin Company Management (Added)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");
const {
  generateComplianceReport,
  getComplianceHistory,
} = require("../services/compliance.service");

const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireFinanceOrAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE && req.user.role !== FINANCE_ROLE) {
    return res.status(403).json({ ok: false, error: "Finance or Admin only" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

/* =========================================================
   ADMIN — LIST COMPANIES
   GET /api/admin/companies
========================================================= */

router.get("/companies", requireAdmin, (req, res) => {
  try {
    const db = readDb();
    res.json({
      ok: true,
      companies: db.companies || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load companies" });
  }
});

/* =========================================================
   ADMIN — CREATE COMPANY
   POST /api/admin/companies
========================================================= */

router.post("/companies", requireAdmin, (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Company name required",
      });
    }

    const db = readDb();

    const newCompany = {
      id: Date.now().toString(),
      name: name.trim(),
      members: [],
      status: "Active",
      tier: "Standard",
      createdAt: new Date().toISOString(),
    };

    db.companies = db.companies || [];
    db.companies.push(newCompany);

    writeDb(db);

    res.status(201).json({
      ok: true,
      company: newCompany,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to create company" });
  }
});

/* =========================================================
   USERS
========================================================= */

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, users: users.listUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, notifications: listNotifications({}) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
