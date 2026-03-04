// backend/src/routes/incidents.routes.js
// Enterprise Incident Engine — Hardened v4
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

function resolveCompany(req) {
  return req.headers["x-company-id"] || req.user.companyId || null;
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
   SAFE DB ACCESS
========================================================= */

function getDb() {
  const db = readDb() || {};
  if (!db.incidents) db.incidents = [];
  return db;
}

/* =========================================================
   GET INCIDENTS (SCOPED)
========================================================= */

router.get("/", (req, res) => {

  try {

    const db = getDb();

    let incidents = db.incidents || [];

    const companyId = resolveCompany(req);

    if (!isAdmin(req.user.role)) {

      incidents = incidents.filter(
        (i) => String(i.companyId) === String(companyId)
      );

    }

    incidents.sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
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

    const db = getDb();

    const {
      title,
      description,
      severity = "medium",
      priority = "P3"
    } = req.body;

    if (!title) {

      return res.status(400).json({
        ok: false,
        error: "Title is required",
      });

    }

    const companyId = resolveCompany(req);

    const newIncident = {

      id: `inc-${Date.now()}-${Math.random().toString(16).slice(2)}`,

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
          time: new Date(),
          action: "CREATED",
          actor: req.user.id
        }
      ],

      resolution: null

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

      if (!incident.activity) incident.activity = [];

      incident.activity.unshift({
        time: new Date(),
        action: `STATUS_${status.toUpperCase()}`,
        actor: req.user.id
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

    const removed = db.incidents.splice(index, 1)[0];

    writeDb(db);

    writeAudit({

      actor: req.user.id,

      role: req.user.role,

      action: "INCIDENT_DELETED",

      detail: {
        incidentId: removed.id,
      }

    });

    res.json({
      ok: true,
      removed,
    });

  } catch (err) {

    res.status(500).json({
      ok: false,
      error: "Failed to delete incident",
    });

  }

});

module.exports = router;
