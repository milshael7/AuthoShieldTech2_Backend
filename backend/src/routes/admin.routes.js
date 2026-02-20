// backend/src/routes/admin.routes.js
// Phase 28 + 29 — Enterprise Security & Governance Intelligence
// SOC2 • Risk Index • Anomaly Engine • Privilege Mapping • Compliance

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { verifyAuditIntegrity } = require("../lib/audit");
const { generateComplianceReport } = require("../services/compliance.service");
const users = require("../users/user.service");
const { listNotifications } = require("../lib/notify");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";
const FINANCE_ROLE = users?.ROLES?.FINANCE || "Finance";

router.use(authRequired);

/* =========================================================
   ROLE GUARDS
========================================================= */

function requireAdmin(req, res, next) {
  if (req.user.role !== ADMIN_ROLE) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

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

/* =========================================================
   🧠 SECURITY ANOMALY ENGINE
========================================================= */

function computeSecurityRisk(db) {
  const audit = db.audit || [];
  const usersList = db.users || [];
  const refunds = db.refunds || [];
  const disputes = db.disputes || [];

  let risk = 0;

  // Audit integrity
  const auditIntegrity = verifyAuditIntegrity();
  if (!auditIntegrity.ok) risk += 30;

  // High privilege spikes
  const highPrivilegeAccess = audit.filter(
    (a) => a.action === "HIGH_PRIVILEGE_ACCESS"
  );
  if (highPrivilegeAccess.length > 50) risk += 15;

  // Refund anomaly
  if (refunds.length > usersList.length * 0.2) risk += 10;

  // Dispute anomaly
  if (disputes.length > 5) risk += 15;

  // Locked user ratio
  const lockedUsers = usersList.filter(
    (u) => u.subscriptionStatus === "Locked"
  );
  if (lockedUsers.length > usersList.length * 0.3) risk += 10;

  return Math.min(risk, 100);
}

/* =========================================================
   📊 SECURITY POSTURE
========================================================= */

router.get("/security/posture", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const riskIndex = computeSecurityRisk(db);

    const roleDistribution = {
      admin: db.users.filter(u => u.role === "Admin").length,
      finance: db.users.filter(u => u.role === "Finance").length,
      manager: db.users.filter(u => u.role === "Manager").length,
      standard: db.users.filter(
        u =>
          !["Admin", "Finance", "Manager"].includes(u.role)
      ).length,
    };

    res.json({
      ok: true,
      posture: {
        riskIndex,
        auditIntegrity: verifyAuditIntegrity(),
        totalUsers: db.users.length,
        roleDistribution,
        refunds: db.refunds.length,
        disputes: db.disputes.length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔎 SECURITY ANOMALIES DETAIL
========================================================= */

router.get("/security/anomalies", requireFinanceOrAdmin, (req, res) => {
  try {
    const db = readDb();
    const audit = db.audit || [];

    const anomalies = {
      brokenAuditChain: !verifyAuditIntegrity().ok,
      highPrivilegeAccessCount: audit.filter(
        (a) => a.action === "HIGH_PRIVILEGE_ACCESS"
      ).length,
      accessDeniedEvents: audit.filter(
        (a) => a.action?.includes("ACCESS_DENIED")
      ).length,
      refundCount: db.refunds.length,
      disputeCount: db.disputes.length,
    };

    res.json({
      ok: true,
      anomalies,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔐 PRIVILEGE MAP
========================================================= */

router.get("/security/privilege-map", requireAdmin, (req, res) => {
  try {
    const db = readDb();

    const privilegeMap = db.users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      companyId: u.companyId,
      subscriptionStatus: u.subscriptionStatus,
    }));

    res.json({
      ok: true,
      privilegeMap,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔎 SOC2 COMPLIANCE REPORT
========================================================= */

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

/* =========================================================
   🔐 USERS (Admin Only)
========================================================= */

router.get("/users", requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      users: users.listUsersForAccess(req.accessContext),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   🔐 NOTIFICATIONS (Admin Only)
========================================================= */

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
