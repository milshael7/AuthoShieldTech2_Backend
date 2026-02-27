// backend/src/routes/users.routes.js
// Enterprise User Control Layer — Hardened v3
// Deterministic Tenant Scope • Manager Multi-Company • Role Normalized • Audit Complete

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
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

function getManagedCompanyIds(user) {
  if (!Array.isArray(user.managedCompanies)) return [];
  return user.managedCompanies.map(String);
}

function canAccessUser(req, target) {
  if (isAdmin(req.user)) return true;

  if (req.user.id === target.id) return true;

  if (isManager(req.user)) {
    const managed = getManagedCompanyIds(req.user);
    return managed.includes(String(target.companyId));
  }

  if (req.companyId) {
    return String(req.companyId) === String(target.companyId);
  }

  return false;
}

function safeUser(u) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    companyId: u.companyId || null,
    subscriptionStatus: u.subscriptionStatus,
    status: u.status,
    locked: !!u.locked,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/* =========================================================
   LIST USERS (SCOPED)
========================================================= */

router.get("/", (req, res) => {
  try {
    const db = readDb();
    let list = db.users || [];

    if (isAdmin(req.user)) {
      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "USER_LIST_VIEWED_GLOBAL",
      });

      return res.json({
        ok: true,
        users: list.map(safeUser),
      });
    }

    if (isManager(req.user)) {
      const managed = getManagedCompanyIds(req.user);

      list = list.filter(
        u => managed.includes(String(u.companyId))
      );

      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "USER_LIST_VIEWED_MANAGER_SCOPE",
      });

      return res.json({
        ok: true,
        users: list.map(safeUser),
      });
    }

    const self = list.find(u => u.id === req.user.id);

    return res.json({
      ok: true,
      users: self ? [safeUser(self)] : [],
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GET SINGLE USER
========================================================= */

router.get("/:id", (req, res) => {
  try {
    const db = readDb();
    const user = (db.users || []).find(
      u => String(u.id) === String(req.params.id)
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    if (!canAccessUser(req, user)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
      });
    }

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "USER_VIEWED",
      metadata: { targetUser: user.id },
    });

    return res.json({
      ok: true,
      user: safeUser(user),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   UPDATE USER
========================================================= */

router.patch("/:id", (req, res) => {
  try {
    const db = readDb();
    const user = (db.users || []).find(
      u => String(u.id) === String(req.params.id)
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    if (!canAccessUser(req, user)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
      });
    }

    const {
      role,
      subscriptionStatus,
      locked,
      status
    } = req.body || {};

    if (role && isAdmin(req.user)) {
      user.role = role;
    }

    if (subscriptionStatus && isAdmin(req.user)) {
      user.subscriptionStatus = subscriptionStatus;
    }

    if (typeof locked === "boolean" && isAdmin(req.user)) {
      user.locked = locked;
    }

    if (status && isAdmin(req.user)) {
      user.status = status;
    }

    user.updatedAt = new Date().toISOString();

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "USER_UPDATED",
      metadata: { targetUser: user.id },
    });

    return res.json({
      ok: true,
      user: safeUser(user),
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   DELETE USER (ADMIN ONLY)
========================================================= */

router.delete("/:id", (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    const db = readDb();
    db.users = (db.users || []).filter(
      u => String(u.id) !== String(req.params.id)
    );

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "USER_DELETED",
      metadata: { targetUser: req.params.id },
    });

    return res.json({ ok: true });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
