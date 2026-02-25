// backend/src/routes/incidents.routes.js
// Enterprise Incident Engine — Hardened v2
// Auth Protected • Company Scoped • Role Aware

const express = require("express");
const router = express.Router();

const { readDb, writeDb } = require("../lib/db");
const { authRequired } = require("../middleware/auth");
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

/* =========================================================
   GET INCIDENTS (SCOPED)
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = readDb();
    let incidents = db.incidents || [];

    // Admin sees all
    if (!isAdmin(req.user.role)) {
      incidents = incidents.filter(
        (i) => i.companyId === req.user.companyId
      );
    }

    // Sort newest first
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
   CREATE INCIDENT (SCOPED)
========================================================= */

router.post("/", (req, res) => {
  try {
    const db = readDb();
    if (!db.incidents) db.incidents = [];

    const { title, description, severity = "medium" } = req.body;

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
    };

    db.incidents.push(newIncident);
    writeDb(db);

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
   UPDATE INCIDENT STATUS (ROLE SAFE)
========================================================= */

router.patch("/:id/status", (req, res) => {
  try {
    const db = readDb();
    const { id } = req.params;
    const { status } = req.body;

    let incident = db.incidents?.find(i => i.id === id);

    if (!incident) {
      return res.status(404).json({
        ok: false,
        error: "Incident not found",
      });
    }

    // Company scoping
    if (
      !isAdmin(req.user.role) &&
      incident.companyId !== req.user.companyId
    ) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
      });
    }

    if (status) {
      incident.status = status;
    }

    writeDb(db);

    res.json({
      ok: true,
      incident,
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Failed to update incident",
    });
  }
});

module.exports = router;
