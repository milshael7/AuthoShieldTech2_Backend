const express = require("express");
const { readDb, writeDb } = require("../lib/db");

const router = express.Router();

/* ================= COMPANIES ================= */

router.get("/companies", (req, res) => {
  const db = readDb();
  res.json(db.operatorCompanies || []);
});

router.post("/companies", (req, res) => {
  const db = readDb();
  db.operatorCompanies = db.operatorCompanies || [];

  const company = {
    id: Date.now().toString(),
    ...req.body
  };

  db.operatorCompanies.push(company);

  writeDb(db);

  res.json(company);
});

/* ================= ALERTS ================= */

router.get("/alerts", (req, res) => {
  const db = readDb();
  res.json(db.operatorAlerts || []);
});

router.post("/alerts", (req, res) => {
  const db = readDb();
  db.operatorAlerts = db.operatorAlerts || [];

  const alert = {
    id: Date.now().toString(),
    ...req.body
  };

  db.operatorAlerts.push(alert);

  writeDb(db);

  res.json(alert);
});

/* ================= NOTIFICATIONS ================= */

router.get("/notifications", (req, res) => {
  const db = readDb();
  res.json(db.operatorNotifications || []);
});

/* ================= EMAILS ================= */

router.get("/emails", (req, res) => {
  const db = readDb();
  res.json(db.operatorEmails || []);
});

/* ================= ARCHIVE ================= */

router.get("/archive", (req, res) => {
  const db = readDb();
  res.json(db.operatorArchive || []);
});

module.exports = router;
