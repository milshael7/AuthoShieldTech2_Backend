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
   RISK CALC
========================================================= */

function calculateRisk(assetId, vulnerabilities = []) {
  const assetVulns = vulnerabilities.filter(v => v.assetId === assetId);

  const critical = assetVulns.filter(v => v.severity === "critical").length;
  const high = assetVulns.filter(v => v.severity === "high").length;
  const medium = assetVulns.filter(v => v.severity === "medium").length;
  const low = assetVulns.filter(v => v.severity === "low").length;

  let riskScore =
    100 - (critical * 25 + high * 12 + medium * 6 + low * 3);

  if (riskScore < 5) riskScore = 5;
  if (riskScore > 100) riskScore = 100;

  let status =
    riskScore < 40
      ? "CRITICAL"
      : riskScore < 70
      ? "ELEVATED"
      : "HEALTHY";

  return {
    riskScore: Math.round(riskScore),
    status,
    vulnerabilityBreakdown: { critical, high, medium, low },
  };
}

/* =========================================================
   GET ASSETS
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = readDb();
    const assets = db.assets || [];
    const vulnerabilities = db.vulnerabilities || [];

    let scoped = assets;

    if (!isAdmin(req.user.role)) {
      scoped = assets.filter(a => a.companyId === req.user.companyId);
    }

    const enriched = scoped.map(asset => {
      const intelligence = calculateRisk(asset.id, vulnerabilities);

      return {
        ...asset,
        ...intelligence,
        monitoringEnabled: asset.monitoringEnabled ?? true,
        autoProtectEnabled: asset.autoProtectEnabled ?? true,
      };
    });

    res.json({ ok: true, assets: enriched });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to load assets" });
  }
});

/* =========================================================
   CREATE ASSET
========================================================= */

router.post("/", (req, res) => {
  try {
    const { name, type, exposureLevel } = req.body;

    if (!name || !type) {
      return res.status(400).json({ ok: false, error: "Name and type required" });
    }

    const db = readDb();
    if (!db.assets) db.assets = [];

    const newAsset = {
      id: generateId(),
      name: name.trim(),
      type: type.trim(),
      exposureLevel: exposureLevel || "internal",
      companyId: req.user.companyId || null,
      monitoringEnabled: true,
      autoProtectEnabled: true,
      discovered: false,
      confirmed: true,
      sourceAssetId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    db.assets.push(newAsset);
    writeDb(db);

    res.status(201).json({ ok: true, asset: newAsset });

  } catch {
    res.status(500).json({ ok: false, error: "Failed to create asset" });
  }
});

/* =========================================================
   DISCOVERY ENGINE
========================================================= */

router.post("/:id/discover", (req, res) => {
  try {
    const db = readDb();
    const asset = db.assets.find(a => a.id === req.params.id);

    if (!asset) {
      return res.status(404).json({ ok: false, error: "Asset not found" });
    }

    if (!isAdmin(req.user.role) &&
        asset.companyId !== req.user.companyId) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    if (asset.type !== "domain") {
      return res.status(400).json({ ok: false, error: "Discovery only supports domain type" });
    }

    const subdomains = [
      `api.${asset.name}`,
      `admin.${asset.name}`,
      `dev.${asset.name}`,
      `staging.${asset.name}`
    ];

    if (!db.assets) db.assets = [];

    subdomains.forEach(sub => {
      const exists = db.assets.find(a => a.name === sub);
      if (!exists) {
        db.assets.push({
          id: generateId(),
          name: sub,
          type: "domain",
          exposureLevel: "public",
          companyId: asset.companyId,
          monitoringEnabled: true,
          autoProtectEnabled: true,
          discovered: true,
          confirmed: false,
          sourceAssetId: asset.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });

    asset.lastDiscoveredAt = Date.now();
    asset.updatedAt = Date.now();

    writeDb(db);

    res.json({ ok: true });

  } catch {
    res.status(500).json({ ok: false, error: "Discovery failed" });
  }
});

/* =========================================================
   CONFIRM DISCOVERED ASSET
========================================================= */

router.post("/:id/confirm", (req, res) => {
  try {
    const db = readDb();
    const asset = db.assets.find(a => a.id === req.params.id);

    if (!asset) {
      return res.status(404).json({ ok: false, error: "Asset not found" });
    }

    asset.confirmed = true;
    asset.updatedAt = Date.now();

    writeDb(db);

    res.json({ ok: true, asset });

  } catch {
    res.status(500).json({ ok: false, error: "Confirmation failed" });
  }
});

/* ========================================================= */

module.exports = router;
