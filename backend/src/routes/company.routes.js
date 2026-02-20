// backend/src/routes/company.routes.js
// Company Routes — Enterprise Hardened
// Tenant Safe • Role Scoped • AutoProtect Layer Added

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const companyService = require("../companies/company.service");
const { updateDb } = require("../lib/db");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function requireCompanyAccess(req, companyId) {
  const isAdmin = req.user.role === "Admin";

  if (isAdmin) return;

  if (!req.user.companyId) {
    const err = new Error("No company access");
    err.status = 403;
    throw err;
  }

  if (String(req.user.companyId) !== String(companyId)) {
    const err = new Error("Access denied to this company");
    err.status = 403;
    throw err;
  }
}

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

/* =========================================================
   CREATE COMPANY (ADMIN ONLY)
========================================================= */

router.post("/", requireRole("Admin"), (req, res) => {
  try {
    const {
      name,
      country,
      website,
      industry,
      contactEmail,
      contactPhone,
      tier,
    } = req.body;

    const company = companyService.createCompany({
      name,
      country,
      website,
      industry,
      contactEmail,
      contactPhone,
      tier,
      createdBy: req.user.id,
    });

    res.status(201).json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   LIST COMPANIES
========================================================= */

router.get(
  "/",
  requireRole("Admin", "Manager", "Company", { adminAlso: true }),
  (req, res) => {
    try {
      const all = companyService.listCompanies();

      if (req.user.role === "Company") {
        const own = all.filter(
          (c) => String(c.id) === String(req.user.companyId)
        );

        return res.json({ ok: true, companies: own });
      }

      res.json({ ok: true, companies: all });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   GET COMPANY
========================================================= */

router.get("/:id", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const company = companyService.getCompany(req.params.id);

    if (!company) {
      return res.status(404).json({
        ok: false,
        error: "Company not found",
      });
    }

    res.json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 403).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   UPGRADE COMPANY
========================================================= */

router.post("/:id/upgrade", requireRole("Admin"), (req, res) => {
  try {
    const { tier } = req.body;

    const company = companyService.upgradeCompany(
      req.params.id,
      tier,
      req.user.id
    );

    res.json({ ok: true, company });
  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   ADD MEMBER
========================================================= */

router.post(
  "/:id/members",
  requireRole("Admin", "Company", { adminAlso: true }),
  (req, res) => {
    try {
      requireCompanyAccess(req, req.params.id);

      const { userId, position } = req.body;

      const company = companyService.addMember(
        req.params.id,
        userId,
        req.user.id,
        position
      );

      res.json({ ok: true, company });
    } catch (e) {
      res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   REMOVE MEMBER
========================================================= */

router.delete(
  "/:id/members/:userId",
  requireRole("Admin", "Company", { adminAlso: true }),
  (req, res) => {
    try {
      requireCompanyAccess(req, req.params.id);

      const company = companyService.removeMember(
        req.params.id,
        req.params.userId,
        req.user.id
      );

      res.json({ ok: true, company });
    } catch (e) {
      res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   🔥 AUTOPROTECT — SET SCHEDULE (PER COMPANY / PER USER)
========================================================= */

router.post("/:id/autoprotect/schedule", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const {
      timezone,
      workingDays,
      startTime,
      endTime,
    } = req.body;

    updateDb((db) => {
      db.autoprotek = db.autoprotek || { users: {} };
      db.autoprotek.users = db.autoprotek.users || {};

      const userId = req.user.id;

      if (!db.autoprotek.users[userId]) {
        db.autoprotek.users[userId] = {
          companies: {},
        };
      }

      const container =
        db.autoprotek.users[userId];

      container.companies =
        container.companies || {};

      if (!container.companies[req.params.id]) {
        container.companies[req.params.id] = {};
      }

      container.companies[req.params.id].schedule = {
        timezone: clean(timezone, 100),
        workingDays: Array.isArray(workingDays)
          ? workingDays
          : [],
        startTime: clean(startTime, 20),
        endTime: clean(endTime, 20),
      };
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   🔥 AUTOPROTECT — SET VACATION
========================================================= */

router.post("/:id/autoprotect/vacation", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const { from, to } = req.body;

    updateDb((db) => {
      db.autoprotek = db.autoprotek || { users: {} };
      db.autoprotek.users = db.autoprotek.users || {};

      const userId = req.user.id;

      if (!db.autoprotek.users[userId]) {
        db.autoprotek.users[userId] = {
          companies: {},
        };
      }

      const container =
        db.autoprotek.users[userId];

      container.companies =
        container.companies || {};

      if (!container.companies[req.params.id]) {
        container.companies[req.params.id] = {};
      }

      container.companies[req.params.id].vacation = {
        from: clean(from, 50),
        to: clean(to, 50),
      };
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   🔥 AUTOPROTECT — SET COMPANY EMAIL
========================================================= */

router.post("/:id/autoprotect/email", (req, res) => {
  try {
    requireCompanyAccess(req, req.params.id);

    const { email } = req.body;

    updateDb((db) => {
      db.autoprotek = db.autoprotek || { users: {} };
      db.autoprotek.users = db.autoprotek.users || {};

      const userId = req.user.id;

      if (!db.autoprotek.users[userId]) {
        db.autoprotek.users[userId] = {
          companies: {},
        };
      }

      const container =
        db.autoprotek.users[userId];

      container.companies =
        container.companies || {};

      if (!container.companies[req.params.id]) {
        container.companies[req.params.id] = {};
      }

      container.companies[req.params.id].email =
        clean(email, 200);
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
