// backend/src/routes/autoprotect.routes.js
// AutoProtect Routes — Billing Enforced • Active Job Model • Enterprise Safe

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const users = require("../users/user.service");

const {
  activateAutoProtect,
  deactivateAutoProtect,
  canRunAutoProtect,
  isAutoProtectActive,
} = require("../users/user.service");

const { runAutoProtectJob } = require("../autoprotect/autoprotect.service");
const { readDb } = require("../lib/db");

router.use(authRequired);

/* ========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function isAdmin(user) {
  return user.role === users.ROLES.ADMIN;
}

function isManager(user) {
  return user.role === users.ROLES.MANAGER;
}

function isIndividual(user) {
  return user.role === users.ROLES.INDIVIDUAL;
}

/* =========================================================
   STATUS
========================================================= */

router.get("/status", (req, res) => {
  const user = req.user;
  const db = readDb();

  // Admin / Manager → read-only global mirror
  if (isAdmin(user) || isManager(user)) {
    const apUsers = Object.values(db.autoprotek?.users || {});

    return res.json({
      scope: "global",
      totalSubscribers: apUsers.length,
      activeSubscribers: apUsers.filter(u => u.status === "ACTIVE").length,
      pastDueSubscribers: apUsers.filter(u => u.subscriptionStatus === "PAST_DUE").length,
      time: nowISO(),
      readOnly: true,
    });
  }

  if (!isIndividual(user)) {
    return res.status(403).json({
      ok: false,
      error: "AutoProtect available to Individuals only.",
    });
  }

  const userAP = db.autoprotek?.users?.[user.id];

  return res.json({
    scope: "user",
    status: userAP?.status || "INACTIVE",
    subscriptionStatus: userAP?.subscriptionStatus || "INACTIVE",
    activeJobs: userAP?.activeJobsCount || 0,
    activeLimit: userAP?.activeJobLimit || 10,
    nextBillingDate: userAP?.nextBillingDate || null,
    pricing: userAP?.pricing || {
      automationService: 500,
      platformFee: 50,
      total: 550,
    },
    time: nowISO(),
  });
});

/* =========================================================
   ENABLE
========================================================= */

router.post("/enable", (req, res) => {
  const user = req.user;

  if (!isIndividual(user)) {
    return res.status(403).json({
      ok: false,
      error: "AutoProtect available to Individuals only.",
    });
  }

  activateAutoProtect(user.id);

  return res.json({
    ok: true,
    status: "ACTIVE",
    pricing: {
      automationService: 500,
      platformFee: 50,
      total: 550,
    },
    limit: 10,
    time: nowISO(),
  });
});

/* =========================================================
   DISABLE
========================================================= */

router.post("/disable", (req, res) => {
  const user = req.user;

  if (!isIndividual(user)) {
    return res.status(403).json({
      ok: false,
      error: "AutoProtect available to Individuals only.",
    });
  }

  deactivateAutoProtect(user.id);

  return res.json({
    ok: true,
    status: "INACTIVE",
    time: nowISO(),
  });
});

/* =========================================================
   RUN JOB
========================================================= */

router.post("/run", (req, res) => {
  const user = req.user;

  if (!canRunAutoProtect(user)) {
    return res.status(400).json({
      ok: false,
      error: "AutoProtect inactive, expired, or active job limit reached (10).",
    });
  }

  const { companyId, title, issue } = req.body || {};

  if (!companyId || !title || !issue) {
    return res.status(400).json({
      ok: false,
      error: "Missing companyId, title, or issue.",
    });
  }

  try {
    const report = runAutoProtectJob({
      actorId: user.id,
      companyId,
      title,
      issue,
    });

    return res.status(201).json({
      ok: true,
      report,
      time: nowISO(),
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
