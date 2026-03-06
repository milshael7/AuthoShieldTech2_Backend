// backend/src/routes/incidents.routes.js
// =========================================================
// ENTERPRISE INCIDENT ENGINE v5 (SEALED)
// QUIET MODE • AUTH REQUIRED • COMPANY SCOPED
// DETERMINISTIC • AUDIT-SAFE • NO SECURITY AUTHORITY
// =========================================================

const express = require("express");
const router = express.Router();

const { readDb, writeDb } = require("../lib/db");
const { authRequired } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

/* ================= CONFIG ================= */

const ADMIN_ROLE = users?.ROLES?.ADMIN || "admin";

const VALID_STATUSES = [
  "open",
  "investigating",
  "contained",
  "resolved",
  "archived",
];

/* ================= AUTH ================= */

router.use(authRequired);

/* ================= HELPERS ================= */

function normalize(v) {
  return String(v || "").toLowerCase();
}

function isAdmin(role) {
  return normalize(role) === normalize(ADMIN_ROLE);
}

function resolveCompany(req) {
  return (
    req.headers["x-company-id"] ||
    req.user.companyId ||
    null
  );
}

function requireCompanyAccess(req, companyId) {
  if (isAdmin(req.user.role)) return;

  if (!req.user.companyId) {
    const err = new Error("No company access");
    err.status = 403;
    throw err;
  }

  if (
    String(req.user.companyId) !== String(companyId)
  ) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

function getDb() {
  const db = readDb() || {};
  if (!Array.isArray(db.incidents)) {
    db.incidents = [];
  }
  return db;
}

/* =========================================================
   GET INCIDENTS (SCOPED, READ-ONLY)
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = getDb();
    let incidents = db.incidents;

    const companyId = resolveCompany(req);

    if (!isAdmin(req.user.role)) {
      incidents = incidents.filter(
        (i) =>
          String(i.companyId) === String(companyId)
      );
    }

    incidents.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
    );

    return res.json({
      ok: true,
      incidents,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to load incidents",
    });
  }
});

/* =========================================================
   CREATE INCIDENT (QUIET)
========================================================= */

router.post("/", (req, res) => {
  try {
    const db = getDb();

    const {
      title,
      description,
      severity = "medium",
      priority = "P3",
    } = req.body;

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Title is required",
      });
    }

    const companyId = resolveCompany(req);

    const incident = {
      id: `inc-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,

      title,
      description: description || "",

      severity,
      priority,

      status: "open",
      companyId,

      createdAt: new Date().toISOString(),
      createdBy: req.user.id,

      activity: [
        {
          time: new Date().toISOString(),
          action: "CREATED",
          actor: req.user.id,
        },
      ],

      resolution: null,
    };

    db.incidents.push(incident);
    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "INCIDENT_CREATED",
      detail: {
        incidentId: incident.id,
        companyId,
      },
    });

    return res.status(201).json({
      ok: true,
      incident,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to create incident",
    });
  }
});

/* =========================================================
   UPDATE INCIDENT STATUS (VALIDATED)
========================================================= */

router.patch("/:id/status", (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { status } = req.body;

    const incident = db.incidents.find(
      (i) => String(i.id) === String(id)
    );

    if (!incident) {
      return res.status(404).json({
        ok: false,
        error: "Incident not found",
      });
    }

    requireCompanyAccess(req, incident.companyId);

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid status",
        });
      }

      incident.status = status;
      incident.activity =
        incident.activity || [];

      incident.activity.unshift({
        time: new Date().toISOString(),
        action: `STATUS_${status.toUpperCase()}`,
        actor: req.user.id,
      });
    }

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "INCIDENT_STATUS_UPDATED",
      detail: {
        incidentId: incident.id,
        status: incident.status,
      },
    });

    return res.json({
      ok: true,
      incident,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error:
        err.message ||
        "Failed to update incident",
    });
  }
});

/* =========================================================
   DELETE INCIDENT (ADMIN ONLY)
========================================================= */

router.delete("/:id", (req, res) => {
  try {
    if (!isAdmin(req.user.role)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    const db = getDb();
    const { id } = req.params;

    const index = db.incidents.findIndex(
      (i) => String(i.id) === String(id)
    );

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "Incident not found",
      });
    }

    const removed = db.incidents.splice(
      index,
      1
    )[0];

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "INCIDENT_DELETED",
      detail: {
        incidentId: removed.id,
      },
    });

    return res.json({
      ok: true,
      removed,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Failed to delete incident",
    });
  }
});

module.exports = router;
