// backend/src/routes/autoprotect.routes.js
// AutoProtect Routes — Engine Integrated • Limit Enforced • Individual Only

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const users = require("../users/user.service");
const {
  activateAutoProtect,
  deactivateAutoProtect,
  canRunAutoProtect,
} = require("../users/user.service");

const { runAutoProtectJob } = require("../autoprotect/autoprotect.service");
const { readDb } = require("../lib/db");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function isIndividual(user) {
  return user.role === users.ROLES.INDIVIDUAL;
}

function isAdmin(user) {
  return user.role === users.ROLES.ADMIN;
}

function isManager(user) {
  return user.role === users.ROLES.MANAGER;
}

/* =========================================================
   STATUS
========================================================= */

router.get("/status", (req, res) => {
  const user = req.user;
  const db = readDb();

  // Admin / Manager = read-only mirror
  if (isAdmin(user) || isManager(user)) {
    const apUsers = Object.keys(
      db.autoprotek?.users || {}
    );

    return res.json({
      scope: "global",
      totalActive: apUsers.length,
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

  const userAP =
    db.autoprotek?.users?.[user.id];

  return res.json({
    scope: "user",
    status: userAP?.status || "INACTIVE",
    monthlyLimit: userAP?.monthlyJobLimit || 0,
    jobsUsed: userAP?.jobsUsedThisMonth || 0,
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
   RUN JOB (ENGINE)
========================================================= */

router.post("/run", (req, res) => {
  const user = req.user;

  if (!isIndividual(user)) {
    return res.status(403).json({
      ok: false,
      error: "AutoProtect available to Individuals only.",
    });
  }

  if (!canRunAutoProtect(user.id)) {
    return res.status(400).json({
      ok: false,
      error: "AutoProtect inactive or monthly limit reached.",
    });
  }

  const { companyId, title, issue } =
    req.body || {};

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
