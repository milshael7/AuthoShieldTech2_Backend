// backend/src/routes/admin.routes.js
// Admin API — Phase 10
// Approval + Tool Governance + Company Hierarchy + Scan Control Engine

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { listNotifications } = require("../lib/notify");
const { readDb, writeDb, updateDb } = require("../lib/db");
const { nanoid } = require("nanoid");

/* =========================================================
   ROLE SAFETY
========================================================= */

const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function requireId(id) {
  const clean = cleanStr(id, 100);
  if (!clean) throw new Error("Invalid id");
  return clean;
}

function ensureArrays(db) {
  if (!Array.isArray(db.companies)) db.companies = [];
  if (!Array.isArray(db.scans)) db.scans = [];
}

/* =========================================================
   SCAN CONTROL SYSTEM (NEW)
========================================================= */

/**
 * FORCE COMPLETE SCAN
 */
router.post("/scan/:id/force-complete", (req, res) => {
  try {
    const scanId = requireId(req.params.id);

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      if (scan.status === "completed") return;

      scan.status = "completed";
      scan.completedAt = new Date().toISOString();

      if (!scan.result) {
        scan.result = {
          overview: {
            riskScore: 50,
            riskLevel: "Moderate",
          },
          findings: ["Manually completed by admin."],
        };
      }
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/**
 * CANCEL SCAN
 */
router.post("/scan/:id/cancel", (req, res) => {
  try {
    const scanId = requireId(req.params.id);

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      scan.status = "cancelled";
      scan.completedAt = new Date().toISOString();
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/**
 * OVERRIDE RISK SCORE
 */
router.post("/scan/:id/override-risk", (req, res) => {
  try {
    const scanId = requireId(req.params.id);
    const riskScore = Number(req.body?.riskScore);

    if (!Number.isFinite(riskScore)) {
      throw new Error("Invalid risk score");
    }

    updateDb((db) => {
      ensureArrays(db);

      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) throw new Error("Scan not found");

      if (!scan.result) {
        scan.result = {
          overview: {},
          findings: [],
        };
      }

      scan.result.overview.riskScore = riskScore;

      if (riskScore >= 70) {
        scan.result.overview.riskLevel = "High";
      } else if (riskScore >= 45) {
        scan.result.overview.riskLevel = "Moderate";
      } else {
        scan.result.overview.riskLevel = "Low";
      }
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/* =========================================================
   EXISTING ADMIN SYSTEM BELOW (UNCHANGED)
========================================================= */

/* ... keep your entire existing admin system code below here exactly as before ... */
