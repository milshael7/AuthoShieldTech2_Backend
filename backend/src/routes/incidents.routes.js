// backend/src/routes/incidents.routes.js
// Enterprise Incident Engine — Hardened v3
// Auth Protected • Company Scoped • Audit Safe • Status Validation

const express = require("express");
const router = express.Router();

const { readDb, writeDb } = require("../lib/db");
const { authRequired } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

/* =========================================================
   AUTH REQUIRED
========================================================= */

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function isAdmin(role) {
  return String(role) === ADMIN_ROLE;
}

function requireCompanyAccess(req, companyId) {

  if (isAdmin(req.user.role)) return;

  if (!req.user.companyId) {
    throw Object.assign(
      new Error("No company access"),
      { status: 403 }
    );
  }

  if (String(req.user.companyId) !== String(companyId)) {
    throw Object.assign(
      new Error("Forbidden"),
      { status: 403 }
    );
  }

}

/* =========================================================
   VALID INCIDENT STATUSES
========================================================= */

const VALID_STATUSES = [
  "open",
  "investigating",
  "contained",
  "resolved",
  "archived"
];

/* =========================================================
   GET INCIDENTS (SCOPED)
========================================================= */

router.get("/", (req, res) => {

  try {

    const db = readDb();
    let incidents = db.incidents || [];

    if (!isAdmin(req.user.role)) {

      incidents = incidents.filter(
        (i) => i.companyId === req.user.companyId
      );

    }

    incidents.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
    );

    res.json({
      ok: true,
      incidents,
    });

  } catch (err) {

    res.status(500).json({
      ok: false,
      error: "Failed to load incidents",
    });

  }

});

/* =========================================================
   CREATE INCIDENT
========================================================= */

router.post("/", (req, res) => {

  try {

    const db = readDb();

    if (!db.incidents) db.incidents = [];

    const {
      title,
      description,
      severity = "medium"
    } = req.body;

    if (!title) {

      return res.status(400).json({
        ok: false,
        error: "Title is required",
      });

    }

    const newIncident = {

      id: Date.now().toString(),

      title,
      description: description || "",

      severity,

      status: "open",

      companyId: req.user.companyId || null,

      createdAt: new Date().toISOString(),

      createdBy: req.user.id,

    };

    db.incidents.push(newIncident);

    writeDb(db);

    writeAudit({

      actor: req.user.id,

      role: req.user.role,

      action: "INCIDENT_CREATED",

      detail: {
        incidentId: newIncident.id,
        companyId: newIncident.companyId,
      }

    });

    res.status(201).json({

      ok: true,

      incident: newIncident,

    });

  } catch (err) {

    res.status(500).json({
      ok: false,
      error: "Failed to create incident",
    });

  }

});

/* =========================================================
   UPDATE INCIDENT STATUS
========================================================= */

router.patch("/:id/status", (req, res) => {

  try {

    const db = readDb();

    const { id } = req.params;

    const { status } = req.body;

    const incident = db.incidents?.find(
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

    }

    writeDb(db);

    writeAudit({

      actor: req.user.id,

      role: req.user.role,

      action: "INCIDENT_STATUS_UPDATED",

      detail: {
        incidentId: incident.id,
        status: incident.status,
      }

    });

    res.json({

      ok: true,

      incident,

    });

  } catch (err) {

    res.status(err.status || 500).json({

      ok: false,

      error: err.message || "Failed to update incident",

    });

  }

});

module.exports = router;
