// backend/src/routes/autoprotect.routes.js
// Autodev 6.5 — Fully Hardened
// Enforced via Tools Engine + Role Model
// Admin / Manager = Unlimited
// Individual ACTIVE = 10 Max
// Company = Not Allowed

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const users = require("../users/user.service");

const {
  canAccessTool,
  seedToolsIfEmpty
} = require("../lib/tools.engine");

const {
  autoProtectLimit,
  enforceLimit
} = require("../lib/autodev");

router.use(authRequired);

/* ========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function getUser(userId) {
  const db = readDb();
  return db.users.find(u => u.id === userId);
}

function getAutodevTool(db) {
  seedToolsIfEmpty(db);
  return (db.tools || []).find(t => t.id === "autodev-65");
}

function isUnlimited(user) {
  return (
    user.role === users.ROLES.ADMIN ||
    user.role === users.ROLES.MANAGER
  );
}

/* =========================================================
   STATUS
========================================================= */

router.get("/status", (req, res) => {
  const db = readDb();
  const user = getUser(req.user.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: "User not found" });
  }

  const tool = getAutodevTool(db);

  const allowed = canAccessTool(
    user,
    tool,
    users.ROLES,
    users.SUBSCRIPTION
  );

  const limit = isUnlimited(user)
    ? Infinity
    : autoProtectLimit(user);

  return res.json({
    ok: true,
    autodev: {
      allowed,
      enabled: !!user.autoprotectEnabled,
      limit: limit === Infinity ? "unlimited" : limit,
      activeCompanies: user.managedCompanies || [],
      activeCount: user.managedCompanies?.length || 0
    },
    time: nowISO()
  });
});

/* =========================================================
   ENABLE
========================================================= */

router.post("/enable", (req, res) => {
  const db = readDb();
  const user = getUser(req.user.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: "User not found" });
  }

  const tool = getAutodevTool(db);

  const allowed = canAccessTool(
    user,
    tool,
    users.ROLES,
    users.SUBSCRIPTION
  );

  if (!allowed) {
    return res.status(403).json({
      ok: false,
      error: "Autodev 6.5 not permitted for this account."
    });
  }

  const check = enforceLimit(user);
  if (!check.ok) {
    return res.status(400).json({
      ok: false,
      error: check.error
    });
  }

  updateDb(db => {
    const u = db.users.find(x => x.id === user.id);
    if (u) {
      u.autoprotectEnabled = true;
      u.updatedAt = nowISO();
    }
    return db;
  });

  return res.json({
    ok: true,
    status: "ACTIVE",
    time: nowISO()
  });
});

/* =========================================================
   DISABLE
========================================================= */

router.post("/disable", (req, res) => {
  updateDb(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (u) {
      u.autoprotectEnabled = false;
      u.updatedAt = nowISO();
    }
    return db;
  });

  return res.json({
    ok: true,
    status: "INACTIVE",
    time: nowISO()
  });
});

/* =========================================================
   ATTACH COMPANY
========================================================= */

router.post("/attach", (req, res) => {
  const { companyId } = req.body || {};
  if (!companyId) {
    return res.status(400).json({
      ok: false,
      error: "companyId required"
    });
  }

  const db = readDb();
  const user = getUser(req.user.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: "User not found" });
  }

  const tool = getAutodevTool(db);

  const allowed = canAccessTool(
    user,
    tool,
    users.ROLES,
    users.SUBSCRIPTION
  );

  if (!allowed) {
    return res.status(403).json({
      ok: false,
      error: "Autodev not permitted."
    });
  }

  updateDb(db => {
    const u = db.users.find(x => x.id === user.id);
    if (!u.managedCompanies) u.managedCompanies = [];

    if (!u.managedCompanies.includes(companyId)) {
      u.managedCompanies.push(companyId);
    }

    u.updatedAt = nowISO();
    return db;
  });

  const updated = getUser(user.id);
  const check = enforceLimit(updated);

  if (!check.ok) {
    return res.status(400).json({
      ok: false,
      error: check.error
    });
  }

  return res.json({
    ok: true,
    managedCompanies: updated.managedCompanies,
    time: nowISO()
  });
});

/* =========================================================
   DETACH COMPANY
========================================================= */

router.post("/detach", (req, res) => {
  const { companyId } = req.body || {};

  updateDb(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (u && Array.isArray(u.managedCompanies)) {
      u.managedCompanies =
        u.managedCompanies.filter(c => c !== companyId);
      u.updatedAt = nowISO();
    }
    return db;
  });

  return res.json({
    ok: true,
    time: nowISO()
  });
});

module.exports = router;
