const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
const users = require("../users/user.service");

router.use(authRequired);

const ROLES = users?.ROLES || {};
const ADMIN_ROLE = (ROLES.ADMIN || "Admin").toLowerCase();

function isAdmin(role) {
  return String(role || "").toLowerCase() === ADMIN_ROLE;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* =========================================================
   GET ASSETS (SCOPED + INTELLIGENCE)
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = readDb();
    const assets = db.assets || [];
    const vulnerabilities = db.vulnerabilities || [];
    const scans = db.scans || [];

    let scoped = assets;

    if (!isAdmin(req.user.role)) {
      scoped = assets.filter(a => a.companyId === req.user.companyId);
    }

    const enriched = scoped.map(asset => {
      const assetVulns = vulnerabilities.filter(
        v => v.assetId === asset.id
      );

      const critical = assetVulns.filter(v => v.severity === "critical").length;
      const high = assetVulns.filter(v => v.severity === "high").length;
      const medium = assetVulns.filter(v => v.severity === "medium").length;
      const low = assetVulns.filter(v => v.severity === "low").length;

      let riskScore =
        100 -
        (critical * 20 +
          high * 10 +
          medium * 5 +
          low * 2);

      if (riskScore < 5) riskScore = 5;
      if (riskScore > 100) riskScore = 100;

      const lastScan = scans
        .filter(s => s.assetId === asset.id)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      return {
        ...asset,
        vulnerabilities: assetVulns.length,
        riskScore: Math.round(riskScore),
        lastScan: lastScan ? lastScan.timestamp : null,
        status:
          riskScore < 50
            ? "CRITICAL"
            : riskScore < 75
            ? "ELEVATED"
            : "HEALTHY",
      };
    });

    res.json({ ok: true, assets: enriched });

  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to load assets" });
  }
});

/* =========================================================
   CREATE ASSET
========================================================= */

router.post("/", (req, res) => {
  try {
    const { name, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        ok: false,
        error: "Asset name and type required",
      });
    }

    const db = readDb();

    const newAsset = {
      id: generateId(),
      name: String(name).trim(),
      type: String(type).trim(),
      companyId: req.user.companyId || null,
      createdBy: req.user.id,
      createdAt: Date.now(),
    };

    db.assets.push(newAsset);
    writeDb(db);

    res.status(201).json({ ok: true, asset: newAsset });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to create asset" });
  }
});

/* =========================================================
   DELETE ASSET
========================================================= */

router.delete("/:id", (req, res) => {
  try {
    const db = readDb();
    const assetId = req.params.id;

    const asset = db.assets.find(a => a.id === assetId);

    if (!asset) {
      return res.status(404).json({ ok: false, error: "Asset not found" });
    }

    if (!isAdmin(req.user.role) &&
        asset.companyId !== req.user.companyId) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    db.assets = db.assets.filter(a => a.id !== assetId);
    writeDb(db);

    res.json({ ok: true });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to delete asset" });
  }
});

module.exports = router;
