// Company Routes — Clean Layered Architecture
// Routes ONLY — Business logic lives in company.service.js

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const companyService = require("../companies/company.service");

/* =========================================================
   ROLE SETUP
========================================================= */

router.use(authRequired);

/* =========================================================
   CREATE COMPANY
   Admin only
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

      return res.status(201).json({
        ok: true,
        company,
      });

    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   LIST COMPANIES
   Admin + Manager
========================================================= */

router.get(
  "/",
  requireRole("Admin", "Manager", { adminAlso: true }),
  (req, res) => {
    try {
      const companies = companyService.listCompanies();

      return res.json({
        ok: true,
        companies,
      });

    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   GET COMPANY
========================================================= */

router.get("/:id", authRequired, (req, res) => {
  try {
    const company = companyService.getCompany(req.params.id);

    if (!company) {
      return res.status(404).json({
        ok: false,
        error: "Company not found",
      });
    }

    return res.json({
      ok: true,
      company,
    });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   UPGRADE COMPANY
   Admin only
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

      return res.json({
        ok: true,
        company,
      });

    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

/* =========================================================
   ADD MEMBER
   Admin or Company owner
========================================================= */

router.post(
  "/:id/members",
  requireRole("Admin", "Company", { adminAlso: true }),
  (req, res) => {
    try {
      const { userId, position } = req.body;

      const company = companyService.addMember(
        req.params.id,
        userId,
        req.user.id,
        position
      );

      return res.json({
        ok: true,
        company,
      });

    } catch (e) {
      return res.status(400).json({
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
      const company = companyService.removeMember(
        req.params.id,
        req.params.userId,
        req.user.id
      );

      return res.json({
        ok: true,
        company,
      });

    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

module.exports = router;
