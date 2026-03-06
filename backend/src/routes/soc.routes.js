// backend/src/routes/soc.routes.js
// =========================================================
// SOC THREAT QUEUE — ENTERPRISE ALERT ENGINE v5 (SEALED)
// QUIET MODE • AUTH REQUIRED • COMPANY SCOPED
// DETERMINISTIC • AUDIT-SAFE • SECURITY-CONTEXT ALIGNED
// NO SELF-ESCALATION • NO EVENT SPAM
// =========================================================

const express = require("express");
const router = express.Router();

const { readDb, writeDb } = require("../lib/db");
const { authRequired } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

/* ================= CONFIG ================= */

const VALID_STATUSES = [
  "NEW",
  "TRIAGED",
  "INVESTIGATING",
  "CONTAINED",
  "RESOLVED",
  "ARCHIVED",
];

const VALID_PRIORITIES = ["P1", "P2", "P3", "P4"];

/* ================= AUTH ================= */

router.use(authRequired);

/* ================= HELPERS ================= */

function normalize(v) {
  return String(v || "").toUpperCase();
}

function resolveCompany(req) {
  return (
    req.headers["x-company-id"] ||
    req.user.companyId ||
    null
  );
}

function isAdmin(req) {
  return String(req.user.role || "")
    .toLowerCase() === "admin";
}

function requireCompanyAccess(req, companyId) {
  if (isAdmin(req)) return;

  if (!req.user.companyId) {
    const err = new Error("No company access");
    err.status = 403;
    throw err;
  }

  if (
    String(req.user.companyId) !==
    String(companyId)
  ) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

function getDb() {
  const db = readDb() || {};
  if (!Array.isArray(db.socAlerts)) {
    db.socAlerts = [];
  }
  return db;
}

/* =========================================================
   GET SOC ALERTS (SCOPED, READ-ONLY)
========================================================= */

router.get("/alerts", (req, res) => {
  try {
    const db = getDb();
    let alerts = db.socAlerts;

    const companyId = resolveCompany(req);

    if (!isAdmin(req)) {
      alerts = alerts.filter(
        (a) =>
          String(a.companyId) ===
          String(companyId)
      );
    }

    alerts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
    );

    return res.json({
      ok: true,
      alerts,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to load SOC alerts",
    });
  }
});

/* =========================================================
   CREATE SOC ALERT (QUIET)
========================================================= */

router.post("/alerts", (req, res) => {
  try {
    const db = getDb();

    const {
      companyId,
      risk = 0,
      priority = "P3",
      containment = "STABLE",
      deadline,
    } = req.body;

    const resolvedCompany =
      companyId || resolveCompany(req);

    requireCompanyAccess(req, resolvedCompany);

    const alert = {
      id: `soc-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,

      companyId: resolvedCompany,

      risk: Number(risk) || 0,
      priority: VALID_PRIORITIES.includes(
        normalize(priority)
      )
        ? normalize(priority)
        : "P3",

      containment: containment || "STABLE",
      status: "NEW",

      createdAt: new Date().toISOString(),
      deadline: deadline
        ? new Date(deadline).toISOString()
        : new Date(
            Date.now() + 60 * 60 * 1000
          ).toISOString(),

      assignedTo: null,
      locked: false,

      activity: [
        {
          time: new Date().toISOString(),
          action: "CREATED",
          actor: req.user.id,
        },
      ],
    };

    db.socAlerts.unshift(alert);
    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "SOC_ALERT_CREATED",
      detail: {
        alertId: alert.id,
        companyId: alert.companyId,
      },
    });

    return res.status(201).json({
      ok: true,
      alert,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error:
        err.message ||
        "Failed to create SOC alert",
    });
  }
});

/* =========================================================
   UPDATE SOC ALERT (CONTROLLED)
========================================================= */

router.patch("/alerts/:id", (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const alert = db.socAlerts.find(
      (a) => String(a.id) === String(id)
    );

    if (!alert) {
      return res.status(404).json({
        ok: false,
        error: "SOC alert not found",
      });
    }

    requireCompanyAccess(req, alert.companyId);

    if (alert.locked && !isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Alert is locked",
      });
    }

    const updates = req.body || {};

    if (
      updates.status &&
      !VALID_STATUSES.includes(
        normalize(updates.status)
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid status",
      });
    }

    Object.assign(alert, updates);

    alert.activity =
      alert.activity || [];

    alert.activity.unshift({
      time: new Date().toISOString(),
      action: "UPDATED",
      actor: req.user.id,
    });

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "SOC_ALERT_UPDATED",
      detail: { alertId: alert.id },
    });

    return res.json({
      ok: true,
      alert,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error:
        err.message ||
        "Failed to update SOC alert",
    });
  }
});

/* =========================================================
   DELETE SOC ALERT (ADMIN ONLY)
========================================================= */

router.delete("/alerts/:id", (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    const db = getDb();
    const { id } = req.params;

    const index = db.socAlerts.findIndex(
      (a) => String(a.id) === String(id)
    );

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "SOC alert not found",
      });
    }

    const removed = db.socAlerts.splice(
      index,
      1
    )[0];

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "SOC_ALERT_DELETED",
      detail: { alertId: removed.id },
    });

    return res.json({
      ok: true,
      removed,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to delete SOC alert",
    });
  }
});

module.exports = router;
