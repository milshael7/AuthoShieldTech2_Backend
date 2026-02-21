// backend/src/routes/admin.routes.js
// Phase 32 — Executive Finance Intelligence Layer

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const {
  generateComplianceReport,
  getComplianceHistory
} = require("../services/compliance.service");

const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

function requireFinanceOrAdmin(req, res, next) {
  if (
    req.user.role !== ADMIN_ROLE &&
    req.user.role !== FINANCE_ROLE
  ) {
    return res.status(403).json({
      ok: false,
      error: "Finance or Admin only",
    });
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
   REFUND + DISPUTE TIMELINE
========================================================= */

router.get(
  "/refund-dispute-timeline",
  requireFinanceOrAdmin,
  (req, res) => {
    try {
      const db = readDb();
      const refunds = db.refunds || [];
      const disputes = db.disputes || [];

      const dailyMap = {};

      function addEntry(entry, type) {
        if (!entry?.createdAt) return;

        const day = entry.createdAt.slice(0, 10);

        if (!dailyMap[day]) {
          dailyMap[day] = {
            refundAmount: 0,
            disputeAmount: 0,
          };
        }

        const amount = Number(entry.amount || 0);

        if (type === "refund") {
          dailyMap[day].refundAmount += amount;
        }

        if (type === "dispute") {
          dailyMap[day].disputeAmount += amount;
        }
      }

      refunds.forEach(r => addEntry(r, "refund"));
      disputes.forEach(d => addEntry(d, "dispute"));

      const sortedDays = Object.keys(dailyMap).sort();

      let cumulativeRefund = 0;
      let cumulativeDispute = 0;

      const result = sortedDays.map(day => {
        cumulativeRefund += dailyMap[day].refundAmount;
        cumulativeDispute += dailyMap[day].disputeAmount;

        return {
          date: day,
          cumulativeRefund,
          cumulativeDispute,
        };
      });

      res.json({
        ok: true,
        timeline: result,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/* =========================================================
   EXISTING ROUTES PRESERVED
========================================================= */

router.get("/metrics", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const usersList = db.users || [];

    const activeSubscribers = usersList.filter(
      (u) => u.subscriptionStatus === "Active"
    ).length;

    res.json({
      ok: true,
      metrics: {
        totalUsers: usersList.length,
        activeSubscribers,
        totalRevenue: db.revenueSummary?.totalRevenue || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get(
  "/compliance/report",
  requireFinanceOrAdmin,
  async (req, res) => {
    try {
      const report = await generateComplianceReport();
      res.json({ ok: true, complianceReport: report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

router.get(
  "/compliance/history",
  requireFinanceOrAdmin,
  (req, res) => {
    try {
      const limit = Number(req.query.limit || 20);
      const history = getComplianceHistory(limit);
      res.json({ ok: true, history });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      users: users.listUsers(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/notifications", requireAdmin, (req, res) => {
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
