// backend/src/routes/alert.routes.js
// Alert System — Threat Queue API

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");

router.use(authRequired);

/* ==============================
   LIST ALERTS
============================== */

router.get("/", (req, res) => {
  try {
    const db = readDb();
    const alerts = db.alerts || [];
    res.json({ ok: true, alerts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ==============================
   CREATE ALERT
============================== */

router.post("/", (req, res) => {
  try {
    const alert = {
      id: "alert-" + Date.now(),
      companyId: req.body.companyId,
      priority: req.body.priority || "P3",
      risk: req.body.risk || 0,
      containment: req.body.containment || "STABLE",
      status: "NEW",
      createdAt: Date.now(),
      deadline: req.body.deadline || Date.now() + 3600000,
      assignedTo: null,
      locked: false,
      activity: [],
    };

    updateDb((db) => {
      db.alerts = db.alerts || [];
      db.alerts.unshift(alert);
      return db;
    });

    res.json({ ok: true, alert });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ==============================
   UPDATE ALERT
============================== */

router.patch("/:id", (req, res) => {
  try {
    const id = req.params.id;

    updateDb((db) => {

      const alert = (db.alerts || []).find(a => a.id === id);
      if (!alert) throw new Error("Alert not found");

      Object.assign(alert, req.body);

      return db;
    });

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
