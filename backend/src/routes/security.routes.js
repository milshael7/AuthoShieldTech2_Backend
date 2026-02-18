// backend/src/routes/security.routes.js
// Security Tool Control — Company Scoped • Tier Enforced • Hardened

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function resolveCompanyId(req) {
  const role = normRole(req.user.role);

  if (role === normRole(users.ROLES.ADMIN)) {
    return clean(req.query.companyId || req.body?.companyId);
  }

  return clean(req.user.companyId);
}

function requireCompanyContext(req, res) {
  const companyId = resolveCompanyId(req);

  if (!companyId) {
    res.status(400).json({
      ok: false,
      error: "Company context missing",
    });
    return null;
  }

  const company = companies.getCompany(companyId);

  if (!company) {
    res.status(404).json({
      ok: false,
      error: "Company not found",
    });
    return null;
  }

  if (company.status !== "Active") {
    res.status(403).json({
      ok: false,
      error: "Company not active",
    });
    return null;
  }

  return companyId;
}

/* =========================================================
   LIST TOOLS
========================================================= */

router.get(
  "/tools",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompanyContext(req, res);
      if (!companyId) return;

      const tools = securityTools.listTools(companyId);

      return res.json({
        ok: true,
        tools,
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
   INSTALL TOOL
========================================================= */

router.post(
  "/tools/install",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompanyContext(req, res);
      if (!companyId) return;

      const toolId = clean(req.body?.toolId, 50);

      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const result = securityTools.installTool(
        companyId,
        toolId,
        req.user.id
      );

      return res.json({
        ok: true,
        result,
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
   UNINSTALL TOOL
========================================================= */

router.post(
  "/tools/uninstall",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const companyId = requireCompanyContext(req, res);
      if (!companyId) return;

      const toolId = clean(req.body?.toolId, 50);

      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const result = securityTools.uninstallTool(
        companyId,
        toolId,
        req.user.id
      );

      return res.json({
        ok: true,
        result,
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
