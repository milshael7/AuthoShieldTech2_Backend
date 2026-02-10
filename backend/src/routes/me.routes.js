// backend/src/routes/me.routes.js
// Me endpoints — Individual user scope (HARDENED)
//
// Covers:
// - User notifications (self-only)
// - Mark notification read (scoped)
// - Create AutoProtect project (eligibility enforced)
//
// Guarantees:
// - Auth required
// - Tenant-safe
// - AutoProtect rules respected
// - Audited actions

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");
const { createProject } = require("../autoprotect/autoprotect.service");

router.use(authRequired);

/* ================= HELPERS ================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function canUseAutoProtect(user) {
  // Company accounts NEVER get AutoProtect here
  if (user.role === users.ROLES.COMPANY) return false;

  // Managers/Admin handled elsewhere — Me route is Individual
  if (user.role !== users.ROLES.INDIVIDUAL) return false;

  return users.getAutoprotect(user);
}

/* ================= ROUTES ================= */

// GET /api/me/notifications
router.get("/notifications", (req, res) => {
  try {
    return res.json(
      listNotifications({
        userId: req.user.id,
      })
    );
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
      return res.status(400).json({ error: "Missing notification id" });
    }

    const n = markRead(id, req.user.id);
    if (!n) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(n);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// POST /api/me/projects
// Create AutoProtect project (Individual only, paid only)
router.post("/projects", (req, res) => {
  try {
    const user = req.user;

    if (!canUseAutoProtect(user)) {
      return res.status(403).json({
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
      return res.status(400).json({ error: "Missing title" });
    }
    if (!issueType) {
      return res.status(400).json({ error: "Missing issue.type" });
    }

    // 🔒 Company context is locked to user
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

    // 🔒 Audit trail
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

    return res.status(201).json(project);
  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
