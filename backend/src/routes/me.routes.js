// backend/src/routes/me.routes.js
// Me Endpoints — Institutional Hardened
// Individual Scope • Tenant Safe • AutoProtect Guarded • Audited

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");
const { createProject } = require("../autoprotect/autoprotect.service");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function canUseAutoProtect(user) {
  const role = normRole(user.role);

  // Only Individual accounts allowed here
  if (role !== normRole(users.ROLES.INDIVIDUAL)) {
    return false;
  }

  return users.getAutoprotect(user);
}

/* =========================================================
   NOTIFICATIONS
========================================================= */

// GET /api/me/notifications
router.get("/notifications", (req, res) => {
  try {
    const notifications = listNotifications({
      userId: req.user.id,
    }) || [];

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

// POST /api/me/notifications/:id/read
router.post("/notifications/:id/read", (req, res) => {
  try {
    const id = cleanStr(req.params.id, 100);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing notification id",
      });
    }

    const n = markRead(id, req.user.id);

    if (!n) {
      return res.status(404).json({
        ok: false,
        error: "Notification not found",
      });
    }

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

// POST /api/me/projects
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

    const body = req.body || {};

    const title = cleanStr(body.title, 200);
    const issue = body.issue || {};

    const issueType = cleanStr(issue.type, 100);
    const details = cleanStr(issue.details, 2000);

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Missing title",
      });
    }

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
      metadata: {
        issueType,
      },
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
