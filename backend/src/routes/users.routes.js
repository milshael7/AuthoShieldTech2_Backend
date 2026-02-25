// backend/src/routes/users.routes.js
// Enterprise User Control Layer — Hardened v2
// Admin + Manager Scoped • Company Bound • Seat Safe • Audit Logged

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, writeDb } = require("../lib/db");
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
      return res.json({
        ok: true,
        users: list.map(safeUser)
      });
    }

    if (isManager(req.user)) {
      list = list.filter(
        u => u.companyId === req.user.companyId
      );

      return res.json({
        ok: true,
        users: list.map(safeUser)
      });
    }

    const self = list.find(u => u.id === req.user.id);

    return res.json({
      ok: true,
      users: self ? [safeUser(self)] : []
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GET SINGLE USER
========================================================= */

router.get("/:id", (req, res) => {
  try {
    const db = readDb();
    const user = (db.users || []).find(
      u => u.id === req.params.id
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    if (!isAdmin(req.user)) {
      if (!sameCompany(req.user, user) && req.user.id !== user.id) {
        return res.status(403).json({
          ok: false,
          error: "Forbidden"
        });
      }
    }

    res.json({
      ok: true,
      user: safeUser(user)
    });

  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   UPDATE USER (ROLE SAFE)
========================================================= */

router.patch("/:id", (req, res) => {
  try {
    const db = readDb();
    const user = (db.users || []).find(
      u => u.id === req.params.id
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    if (!isAdmin(req.user)) {
      if (!isManager(req.user) || !sameCompany(req.user, user)) {
        return res.status(403).json({
          ok: false,
          error: "Forbidden"
        });
      }
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

    if (typeof locked === "boolean") {
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
      detail: { targetUser: user.id }
    });

    res.json({
      ok: true,
      user: safeUser(user)
    });

  } catch {
    res.status(500).json({ ok: false });
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
        error: "Admin only"
      });
    }

    const db = readDb();
    db.users = (db.users || []).filter(
      u => u.id !== req.params.id
    );

    writeDb(db);

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "USER_DELETED",
      detail: { targetUser: req.params.id }
    });

    res.json({ ok: true });

  } catch {
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
