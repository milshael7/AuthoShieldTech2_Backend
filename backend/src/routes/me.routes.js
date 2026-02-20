// backend/src/routes/me.routes.js
// Me Endpoints — Subscription Enforced • Usage Meter Enabled

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { createProject } = require("../autoprotect/autoprotect.service");
const { getUserEffectivePlan } = require("../users/user.service");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function requireActiveSubscription(dbUser) {
  if (!dbUser) throw new Error("User not found");

  if (dbUser.subscriptionStatus === users.SUBSCRIPTION.LOCKED) {
    const err = new Error("Account locked");
    err.status = 403;
    throw err;
  }

  if (dbUser.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE) {
    const err = new Error("Subscription past due");
    err.status = 402;
    throw err;
  }
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

/* =========================================================
   USAGE METER (NEW)
========================================================= */

router.get("/usage", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const db = readDb();
    const plan = getUserEffectivePlan(dbUser);
    const included = plan.includedScans || 0;

    const monthKey = currentMonthKey();

    let used = 0;

    if (db.scanCredits && db.scanCredits[dbUser.id]) {
      const record = db.scanCredits[dbUser.id];
      if (record.month === monthKey) {
        used = record.used;
      }
    }

    const remaining =
      included === Infinity
        ? Infinity
        : Math.max(0, included - used);

    return res.json({
      ok: true,
      usage: {
        planLabel: plan.label,
        included,
        used,
        remaining,
        month: monthKey,
      },
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   DASHBOARD
========================================================= */

router.get("/dashboard", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    return res.json({
      ok: true,
      dashboard: {
        role: dbUser.role,
        subscriptionStatus: dbUser.subscriptionStatus,
      },
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   SCAN HISTORY
========================================================= */

router.get("/scans", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const db = readDb();
    const scans = (db.scans || [])
      .filter((s) => s.userId === dbUser.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({
      ok: true,
      total: scans.length,
      scans,
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const notifications =
      listNotifications({ userId: req.user.id }) || [];

    return res.json({ ok: true, notifications });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   PROJECT CREATION
========================================================= */

router.post("/projects", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

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

    const project = createProject({
      actorId: dbUser.id,
      companyId: dbUser.companyId || null,
      title,
      issue: req.body.issue || {},
    });

    audit({
      actorId: dbUser.id,
      action: "PROJECT_CREATED",
      targetType: "Project",
      targetId: project.id,
    });

    return res.status(201).json({ ok: true, project });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
