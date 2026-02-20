// backend/src/routes/company.routes.js
// Company Routes — Enterprise Hardened
// Tenant Safe • Role Scoped • No Cross-Company Escalation

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const companyService = require("../companies/company.service");

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

/* =========================================================
   CREATE COMPANY (ADMIN ONLY)
========================================================= */

router.post(
  "/",
  requireRole("Admin"),
  (req, res) => {
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

      res.status(201).json({
        ok: true,
        company,
      });

    } catch (e) {
      res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   LIST COMPANIES
   Admin → all
   Manager → all
   Company → only their own
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

        return res.json({
          ok: true,
          companies: own,
        });
      }

      res.json({
        ok: true,
        companies: all,
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   GET COMPANY (TENANT SAFE)
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

    res.json({
      ok: true,
      company,
    });

  } catch (e) {
    res.status(e.status || 403).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   UPGRADE COMPANY (ADMIN ONLY)
========================================================= */

router.post(
  "/:id/upgrade",
  requireRole("Admin"),
  (req, res) => {
    try {
      const { tier } = req.body;

      const company = companyService.upgradeCompany(
        req.params.id,
        tier,
        req.user.id
      );

      res.json({
        ok: true,
        company,
      });

    } catch (e) {
      res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   ADD MEMBER (ADMIN OR SAME COMPANY OWNER)
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

      res.json({
        ok: true,
        company,
      });

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

      res.json({
        ok: true,
        company,
      });

    } catch (e) {
      res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

module.exports = router;
