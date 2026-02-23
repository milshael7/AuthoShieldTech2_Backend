const express = require("express");
const router = express.Router();
const { readDb, ensureDb } = require("../lib/db");

/* =========================================================
   GET ALL INCIDENTS
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = readDb();

    const incidents = db.incidents || [];

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
      createdAt: new Date().toISOString(),
    };

    db.incidents.push(newIncident);

    require("../lib/db").writeDb(db);

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

    const incident = db.incidents?.find(i => i.id === id);

    if (!incident) {
      return res.status(404).json({
        ok: false,
        error: "Incident not found",
      });
    }

    incident.status = status || incident.status;

    require("../lib/db").writeDb(db);

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
