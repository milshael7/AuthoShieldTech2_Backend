// backend/src/routes/entitlements.routes.js
// Enterprise Entitlement Management — Unified Enforcement v3
// Subscription Aware • Tier Guarded • Governance Compatible • Audit Hardened

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

router.use(authRequired);

/* =========================================================
   ROLE HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").toLowerCase();
}

function isAdmin(user) {
  return normalize(user.role) === normalize(users.ROLES.ADMIN);
}

function isManager(user) {
  return normalize(user.role) === normalize(users.ROLES.MANAGER);
}

function sameCompany(actor, target) {
  return actor.companyId && actor.companyId === target.companyId;
}

function nowISO() {
  return new Date().toISOString();
}

function findUser(userId) {
  const db = readDb();
  return (db.users || []).find((u) => u.id === userId);
}

function ensureEntitlements(user) {
  if (!user.entitlements) {
    user.entitlements = { tools: [] };
  }
  if (!Array.isArray(user.entitlements.tools)) {
    user.entitlements.tools = [];
  }
}

/* =========================================================
   VIEW MY ENTITLEMENTS
========================================================= */

router.get("/me", (req, res) => {
  const user = findUser(req.user.id);
  if (!user) return res.status(404).json({ ok: false });

  ensureEntitlements(user);

  return res.json({
    ok: true,
    entitlements: user.entitlements,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionTier: user.subscriptionTier || "free",
    time: nowISO(),
  });
});

/* =========================================================
   GRANT TOOL (MANUAL)
========================================================= */

router.post("/grant", (req, res) => {
  const actor = req.user;
  const { userId, toolId } = req.body || {};

  if (!userId || !toolId)
    return res.status(400).json({ ok: false, error: "Missing fields" });

  const target = findUser(userId);
  if (!target) return res.status(404).json({ ok: false });

  // Subscription lock guard
  if (String(target.subscriptionStatus).toLowerCase() === "locked") {
    return res.status(403).json({
      ok: false,
      error: "Cannot grant tool to locked subscription",
    });
  }

  // Admin global / Manager same company only
  if (!isAdmin(actor)) {
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({ ok: false });
    }
  }

  updateDb((db) => {
    const user = db.users.find((u) => u.id === userId);
    if (!user) return db;

    ensureEntitlements(user);

    if (!user.entitlements.tools.includes(toolId)) {
      user.entitlements.tools.push(toolId);
    }

    return db;
  });

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "MANUAL_ENTITLEMENT_GRANTED",
    detail: { targetUser: userId, toolId },
  });

  return res.json({
    ok: true,
    message: "Tool granted",
    time: nowISO(),
  });
});

/* =========================================================
   REVOKE TOOL
========================================================= */

router.post("/revoke", (req, res) => {
  const actor = req.user;
  const { userId, toolId } = req.body || {};

  if (!userId || !toolId)
    return res.status(400).json({ ok: false });

  const target = findUser(userId);
  if (!target) return res.status(404).json({ ok: false });

  if (!isAdmin(actor)) {
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({ ok: false });
    }
  }

  updateDb((db) => {
    const user = db.users.find((u) => u.id === userId);
    if (!user?.entitlements?.tools) return db;

    user.entitlements.tools =
      user.entitlements.tools.filter((t) => t !== toolId);

    return db;
  });

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "MANUAL_ENTITLEMENT_REVOKED",
    detail: { targetUser: userId, toolId },
  });

  return res.json({
    ok: true,
    message: "Tool revoked",
    time: nowISO(),
  });
});

/* =========================================================
   REVOKE ALL
========================================================= */

router.post("/revoke-all", (req, res) => {
  const actor = req.user;
  const { userId } = req.body || {};

  if (!userId)
    return res.status(400).json({ ok: false });

  const target = findUser(userId);
  if (!target) return res.status(404).json({ ok: false });

  if (!isAdmin(actor)) {
    if (!isManager(actor) || !sameCompany(actor, target)) {
      return res.status(403).json({ ok: false });
    }
  }

  updateDb((db) => {
    const user = db.users.find((u) => u.id === userId);
    if (!user) return db;

    user.entitlements = { tools: [] };
    return db;
  });

  writeAudit({
    actor: actor.id,
    role: actor.role,
    action: "ALL_MANUAL_ENTITLEMENTS_REVOKED",
    detail: { targetUser: userId },
  });

  return res.json({
    ok: true,
    message: "All tools revoked",
    time: nowISO(),
  });
});

module.exports = router;
