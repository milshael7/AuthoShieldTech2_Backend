// backend/src/routes/security.routes.js
// Security Tool Control — Subscription Enforced • Company Scoped • Hardened
// ✅ Role-safe (no crash if users.ROLES missing)

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");

router.use(authRequired);

/* =========================================================
   ROLE FALLBACKS (CRASH-PROOF)
========================================================= */

const ROLES = users?.ROLES || {};
const SUBS = users?.SUBSCRIPTION || {};

const ADMIN_ROLE = ROLES.ADMIN || "Admin";
const COMPANY_ROLE = ROLES.COMPANY || "Company";

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function requireActiveSubscription(dbUser) {
  if (!dbUser) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  // If SUBS isn't defined, we fail "open" (no crash) and rely on other guards.
  if (SUBS.LOCKED && dbUser.subscriptionStatus === SUBS.LOCKED) {
    const err = new Error("Account locked");
    err.status = 403;
    throw err;
  }

  if (SUBS.PAST_DUE && dbUser.subscriptionStatus === SUBS.PAST_DUE) {
    const err = new Error("Subscription past due");
    err.status = 402;
    throw err;
  }
}

function resolveCompanyId(req) {
  const role = normRole(req.user.role);

  // SAFE: ADMIN_ROLE is always a string
  if (role === normRole(ADMIN_ROLE)) {
    return clean(req.query.companyId || req.body?.companyId);
  }

  return clean(req.user.companyId);
}

function requireCompanyContext(req) {
  const companyId = resolveCompanyId(req);

  if (!companyId) {
    const err = new Error("Company context missing");
    err.status = 400;
    throw err;
  }

  const company = companies.getCompany(companyId);

  if (!company) {
    const err = new Error("Company not found");
    err.status = 404;
    throw err;
  }

  if (company.status !== "Active") {
    const err = new Error("Company not active");
    err.status = 403;
    throw err;
  }

  return companyId;
}

/* =========================================================
   LIST TOOLS
========================================================= */

router.get(
  "/tools",
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = requireCompanyContext(req);

      const tools = securityTools.listTools(companyId);

      return res.json({
        ok: true,
        tools,
      });
    } catch (e) {
      return res.status(e.status || 400).json({
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
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = requireCompanyContext(req);

      const toolId = clean(req.body?.toolId, 50);
      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const result = securityTools.installTool(companyId, toolId, req.user.id);

      return res.json({
        ok: true,
        result,
      });
    } catch (e) {
      return res.status(e.status || 400).json({
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
  requireRole(COMPANY_ROLE, { adminAlso: true }),
  (req, res) => {
    try {
      const dbUser = users.findById(req.user.id);
      requireActiveSubscription(dbUser);

      const companyId = requireCompanyContext(req);

      const toolId = clean(req.body?.toolId, 50);
      if (!toolId) {
        return res.status(400).json({
          ok: false,
          error: "Missing toolId",
        });
      }

      const result = securityTools.uninstallTool(companyId, toolId, req.user.id);

      return res.json({
        ok: true,
        result,
      });
    } catch (e) {
      return res.status(e.status || 400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

module.exports = router;
