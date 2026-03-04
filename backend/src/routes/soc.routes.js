// backend/src/routes/soc.routes.js
// SOC Threat Queue — Alert Engine

const express = require("express");
const router = express.Router();

const { readDb, updateDb } = require("../lib/db");
const { authRequired } = require("../middleware/auth");

router.use(authRequired);

/* ================================
   GET SOC ALERTS
================================ */

router.get("/alerts", (req, res) => {
  try {

    const db = readDb();
    const alerts = db.socAlerts || [];

    res.json({
      ok: true,
      alerts
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});

/* ================================
   CREATE ALERT
================================ */

router.post("/alerts", (req, res) => {

  try {

    const alert = {

      id: "soc-" + Date.now(),

      companyId: req.body.companyId,

      risk: Number(req.body.risk || 0),

      priority: req.body.priority || "P3",

      containment: req.body.containment || "STABLE",

      status: "NEW",

      createdAt: Date.now(),

      deadline: req.body.deadline || Date.now() + 3600000,

      assignedTo: null,

      locked: false,

      activity: []

    };

    updateDb((db) => {

      db.socAlerts = db.socAlerts || [];

      db.socAlerts.unshift(alert);

      return db;

    });

    res.json({
      ok: true,
      alert
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }

});

/* ================================
   UPDATE ALERT
================================ */

router.patch("/alerts/:id", (req, res) => {

  try {

    const id = req.params.id;

    updateDb((db) => {

      const alert = (db.socAlerts || []).find(
        a => String(a.id) === String(id)
      );

      if (!alert)
        throw new Error("Alert not found");

      Object.assign(alert, req.body);

      return db;

    });

    res.json({ ok: true });

  } catch (e) {

    res.status(400).json({
      ok: false,
      error: e.message
    });

  }

});

/* ================================
   DELETE ALERT
================================ */

router.delete("/alerts/:id", (req, res) => {

  try {

    const id = req.params.id;

    updateDb((db) => {

      db.socAlerts = (db.socAlerts || []).filter(
        a => String(a.id) !== String(id)
      );

      return db;

    });

    res.json({ ok: true });

  } catch (e) {

    res.status(400).json({
      ok: false,
      error: e.message
    });

  }

});

module.exports = router;
