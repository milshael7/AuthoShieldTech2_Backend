// backend/src/routes/security.routes.js
// Security Tool Control — Plan Enforced • Tenant Locked • Hardened v2

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
      error: "Company suspended",
    });
    return null;
  }

  return { companyId, company };
}

/* =========================================================
   PLAN ENFORCEMENT
========================================================= */

function enforcePlan(company, currentTools) {
  const tier = String(company.tier || "micro").toLowerCase();

  // Example enforcement logic:
  // Micro → max 3 tools
  // Small → max 6 tools
  // Mid → max 15 tools
  // Enterprise/Unlimited → no cap

  const caps = {
    micro: 3,
    small: 6,
    mid: 15,
    enterprise: Infinity,
    unlimited: Infinity,
  };

  const max = caps[tier] ?? 3;

  if (currentTools.length >= max) {
    throw new Error(
      `Plan limit reached (${tier}). Upgrade required.`
    );
  }
}

/* =========================================================
   LIST TOOLS
========================================================= */

router.get(
  "/tools",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const ctx = requireCompanyContext(req, res);
      if (!ctx) return;

      const tools = securityTools.listTools(ctx.companyId);

      return res.json({
        ok: true,
        plan: ctx.company.tier,
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
   INSTALL TOOL (PLAN SAFE)
========================================================= */

router.post(
  "/tools/install",
  requireRole(users.ROLES.COMPANY, { adminAlso: true }),
  (req, res) => {
    try {
      const ctx = requireCompanyContext(req, res);
      if (!ctx) return;

      const toolId = clean(req.body?.toolId, 50);
      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const current = securityTools.listTools(ctx.companyId);

      enforcePlan(ctx.company, current.installed);

      const result = securityTools.installTool(
        ctx.companyId,
        toolId,
        req.user.id
      );

      return res.json({
        ok: true,
        plan: ctx.company.tier,
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
      const ctx = requireCompanyContext(req, res);
      if (!ctx) return;

      const toolId = clean(req.body?.toolId, 50);

      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const result = securityTools.uninstallTool(
        ctx.companyId,
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
