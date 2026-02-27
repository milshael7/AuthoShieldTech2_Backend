// backend/src/routes/entitlements.routes.js
// Enterprise Entitlement Management — Hardened v4
// Deterministic Tenant Enforcement • Canonical Context • Audit Safe

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function normalize(role) {
  return String(role || "").trim().toLowerCase();
}

function isAdmin(user) {
  return normalize(user.role) === "admin";
}

function isManager(user) {
  return normalize(user.role) === "manager";
}

function nowISO() {
  return new Date().toISOString();
}

function findUser(db, userId) {
  return (db.users || []).find(
    (u) => String(u.id) === String(userId)
  );
}

function ensureEntitlements(user) {
  if (!user.entitlements) {
    user.entitlements = { tools: [] };
  }
  if (!Array.isArray(user.entitlements.tools)) {
    user.entitlements.tools = [];
  }
}

function subscriptionActive(user) {
  const s = normalize(user.subscriptionStatus);
  return s === "active" || s === "trial";
}

function sameCompanyContext(req, target) {
  if (!req.companyId) return false;
  return String(req.companyId) === String(target.companyId);
}

/* =========================================================
   VIEW MY ENTITLEMENTS
========================================================= */

router.get("/me", (req, res) => {
  try {
    const db = readDb();
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    ensureEntitlements(user);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "ENTITLEMENTS_VIEWED",
    });

    return res.json({
      ok: true,
      entitlements: user.entitlements,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionTier: user.subscriptionTier || "free",
      time: nowISO(),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GRANT TOOL (MANUAL)
========================================================= */

router.post("/grant", (req, res) => {
  try {
    const actor = req.user;
    const { userId, toolId } = req.body || {};

    if (!userId || !toolId) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields"
      });
    }

    const db = readDb();
    const target = findUser(db, userId);
    if (!target) return res.status(404).json({ ok: false });

    if (!subscriptionActive(target)) {
      return res.status(403).json({
        ok: false,
        error: "Subscription inactive"
      });
    }

    if (!isAdmin(actor)) {
      if (!isManager(actor) || !sameCompanyContext(req, target)) {
        return res.status(403).json({ ok: false });
      }
    }

    updateDb((db2) => {
      const user = findUser(db2, userId);
      if (!user) return db2;

      ensureEntitlements(user);

      if (!user.entitlements.tools.includes(toolId)) {
        user.entitlements.tools.push(toolId);
      }

      return db2;
    });

    writeAudit({
      actor: actor.id,
      role: actor.role,
      action: "MANUAL_ENTITLEMENT_GRANTED",
      metadata: { targetUser: userId, toolId },
    });

    return res.json({
      ok: true,
      message: "Tool granted",
      time: nowISO(),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REVOKE TOOL
========================================================= */

router.post("/revoke", (req, res) => {
  try {
    const actor = req.user;
    const { userId, toolId } = req.body || {};

    if (!userId || !toolId) {
      return res.status(400).json({ ok: false });
    }

    const db = readDb();
    const target = findUser(db, userId);
    if (!target) return res.status(404).json({ ok: false });

    if (!isAdmin(actor)) {
      if (!isManager(actor) || !sameCompanyContext(req, target)) {
        return res.status(403).json({ ok: false });
      }
    }

    updateDb((db2) => {
      const user = findUser(db2, userId);
      if (!user?.entitlements?.tools) return db2;

      user.entitlements.tools =
        user.entitlements.tools.filter(
          (t) => String(t) !== String(toolId)
        );

      return db2;
    });

    writeAudit({
      actor: actor.id,
      role: actor.role,
      action: "MANUAL_ENTITLEMENT_REVOKED",
      metadata: { targetUser: userId, toolId },
    });

    return res.json({
      ok: true,
      message: "Tool revoked",
      time: nowISO(),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REVOKE ALL
========================================================= */

router.post("/revoke-all", (req, res) => {
  try {
    const actor = req.user;
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ ok: false });
    }

    const db = readDb();
    const target = findUser(db, userId);
    if (!target) return res.status(404).json({ ok: false });

    if (!isAdmin(actor)) {
      if (!isManager(actor) || !sameCompanyContext(req, target)) {
        return res.status(403).json({ ok: false });
      }
    }

    updateDb((db2) => {
      const user = findUser(db2, userId);
      if (!user) return db2;

      user.entitlements = { tools: [] };
      return db2;
    });

    writeAudit({
      actor: actor.id,
      role: actor.role,
      action: "ALL_MANUAL_ENTITLEMENTS_REVOKED",
      metadata: { targetUser: userId },
    });

    return res.json({
      ok: true,
      message: "All tools revoked",
      time: nowISO(),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
