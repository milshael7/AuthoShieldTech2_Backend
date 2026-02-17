// backend/src/routes/me.routes.js
// Me Endpoints — Institutional Hardened (Phase 5 Integrity Lock)

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");
const { createProject } = require("../autoprotect/autoprotect.service");

router.use(authRequired);

/* =========================================================
   GLOBAL AUTH CONTEXT GUARD
========================================================= */

router.use((req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication context",
    });
  }
  next();
});

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function canUseAutoProtect(user) {
  const role = normRole(user.role);

  if (!role) return false;

  if (role !== normRole(users.ROLES?.INDIVIDUAL || "Individual")) {
    return false;
  }

  if (typeof users.getAutoprotect !== "function") {
    return false;
  }

  return !!users.getAutoprotect(user);
}

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const notifications =
      listNotifications({ userId: req.user.id }) || [];

    return res.json({
      ok: true,
      notifications,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

router.post("/notifications/:id/read", (req, res) => {
  try {
    const id = cleanStr(req.params.id, 100);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing notification id",
      });
    }

    // Defensive check before mutation
    const existing =
      listNotifications({ userId: req.user.id })
        ?.find(n => String(n.id) === id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "Notification not found or not owned by user",
      });
    }

    const n = markRead(id, req.user.id);

    return res.json({
      ok: true,
      notification: n,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   AUTOPROTECT PROJECT CREATION
========================================================= */

router.post("/projects", (req, res) => {
  try {
    const user = req.user;

    if (!canUseAutoProtect(user)) {
      return res.status(403).json({
        ok: false,
        error: "AutoProtect not enabled for this account",
        hint: "Upgrade required",
      });
    }

    if (!isObject(req.body)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request body",
      });
    }

    const title = cleanStr(req.body.title, 200);

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Missing title",
      });
    }

    if (!isObject(req.body.issue)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid issue payload",
      });
    }

    const issueType = cleanStr(req.body.issue.type, 100);
    const details = cleanStr(req.body.issue.details, 2000);

    if (!issueType) {
      return res.status(400).json({
        ok: false,
        error: "Missing issue.type",
      });
    }

    const companyId = user.companyId || null;

    const project = createProject({
      actorId: user.id,
      companyId,
      title,
      issue: {
        type: issueType,
        details,
      },
    });

    audit({
      actorId: user.id,
      action: "AUTOPROTECT_PROJECT_CREATED",
      targetType: "Project",
      targetId: project.id,
      companyId,
      metadata: { issueType },
    });

    return res.status(201).json({
      ok: true,
      project,
    });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
