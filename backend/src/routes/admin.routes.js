// backend/src/routes/admin.routes.js
// Admin API — Phase 13 Enterprise Hardened
// Revenue Analytics • Invoice Intelligence • Scan Control • Audit Safe

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, writeDb, updateDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const { listNotifications } = require("../lib/notify");
const { nanoid } = require("nanoid");

/* =========================================================
   ROLE SAFETY
========================================================= */

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   HELPERS
========================================================= */

function requireId(id) {
  if (!id) throw new Error("Invalid id");
  return String(id).trim();
}

function audit(action, actorId, targetType, targetId, meta = {}) {
  const db = readDb();
  db.audit.push({
    id: nanoid(),
    at: new Date().toISOString(),
    action,
    actorId,
    targetType,
    targetId,
    meta,
  });
  writeDb(db);
}

/* =========================================================
   🔥 REVENUE SUMMARY (REAL DATA)
========================================================= */

router.get("/revenue/summary", (req, res) => {
  try {
    const db = readDb();

    const invoices = db.invoices || [];
    const revenue = db.revenueSummary || {};

    const totalInvoices = invoices.length;
    const totalRevenue = revenue.totalRevenue || 0;
    const autoprotekRevenue = revenue.autoprotekRevenue || 0;
    const subscriptionRevenue = revenue.subscriptionRevenue || 0;
    const toolRevenue = revenue.toolRevenue || 0;

    const uniqueUsers = new Set(invoices.map(i => i.userId)).size;

    const avgRevenuePerUser =
      uniqueUsers > 0
        ? Number((totalRevenue / uniqueUsers).toFixed(2))
        : 0;

    res.json({
      ok: true,
      totalRevenue,
      totalInvoices,
      autoprotekRevenue,
      subscriptionRevenue,
      toolRevenue,
      uniquePayingUsers: uniqueUsers,
      averageRevenuePerUser: avgRevenuePerUser,
      time: new Date().toISOString(),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 MONTHLY REVENUE BREAKDOWN
========================================================= */

router.get("/revenue/monthly", (req, res) => {
  try {
    const db = readDb();
    const invoices = db.invoices || [];

    const monthly = {};

    for (const inv of invoices) {
      const date = new Date(inv.createdAt);
      const key = `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;

      if (!monthly[key]) {
        monthly[key] = {
          total: 0,
          subscription: 0,
          autoprotek: 0,
          tool: 0,
        };
      }

      monthly[key].total += inv.amount;

      if (inv.type === "subscription")
        monthly[key].subscription += inv.amount;
      if (inv.type === "autoprotect")
        monthly[key].autoprotek += inv.amount;
      if (inv.type === "tool")
        monthly[key].tool += inv.amount;
    }

    res.json({
      ok: true,
      monthly,
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 INVOICE LISTING
========================================================= */

router.get("/invoices", (req, res) => {
  try {
    const db = readDb();
    res.json({
      ok: true,
      invoices: db.invoices || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔥 SCAN CONTROL
========================================================= */

router.post("/scan/:id/force-complete", (req, res) => {
  try {
    const scanId = requireId(req.params.id);

    updateDb((db) => {
      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");
      if (scan.status === "completed")
        throw new Error("Already completed");

      scan.status = "completed";
      scan.completedAt = new Date().toISOString();
    });

    audit(
      "ADMIN_FORCE_COMPLETE_SCAN",
      req.user.id,
      "Scan",
      scanId
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   USERS / COMPANIES / NOTIFICATIONS
========================================================= */

router.get("/users", (req, res) => {
  try {
    res.json({ ok: true, users: users.listUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/companies", (req, res) => {
  try {
    res.json({ ok: true, companies: companies.listCompanies() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/notifications", (req, res) => {
  try {
    res.json({
      ok: true,
      notifications: listNotifications({}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
