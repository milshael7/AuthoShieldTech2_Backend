// backend/src/middleware/tenant.js
// AutoShield — Enterprise Tenant Isolation Core (Hardened v5)
// Strict Isolation • Suspension Aware • Restricted Aware

const { readDb } = require("../lib/db");

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function resolveFromSubdomain(req) {
  let host = req.hostname || req.headers.host;
  if (!host) return null;

  host = String(host).split(":")[0];

  if (
    host.includes("localhost") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) {
    return null;
  }

  const parts = host.split(".");
  if (parts.length < 3) return null;

  return clean(parts[0], 50);
}

function tenantMiddleware(req, res, next) {

  // Only enforce tenant for authenticated users
  if (!req.user) {
    return next();
  }

  const db = readDb();
  const role = normRole(req.user.role);
  const isAdmin = role === "admin";

  /* =====================================================
     GLOBAL USER LOCK CHECK
  ===================================================== */

  const dbUser = (db.users || []).find(u => u.id === req.user.id);

  if (!dbUser) {
    return res.status(401).json({ error: "User not found" });
  }

  if (dbUser.locked === true) {
    return res.status(403).json({ error: "Account suspended" });
  }

  let companyId = null;
  let resolvedFrom = null;

  /* =====================================================
     RESOLUTION ORDER
  ===================================================== */

  if (req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
    resolvedFrom = "auth";
  }

  if (!companyId && isAdmin) {
    const headerCompany = req.headers["x-company-id"];
    if (headerCompany) {
      companyId = clean(headerCompany, 50);
      resolvedFrom = "admin-header";
    }
  }

  if (!companyId) {
    const sub = resolveFromSubdomain(req);
    if (sub) {
      companyId = sub;
      resolvedFrom = "subdomain";
    }
  }

  /* =====================================================
     ADMIN GLOBAL MODE
  ===================================================== */

  if (isAdmin && !companyId) {
    req.tenant = {
      id: null,
      type: "global",
      brainKey: "global",
      resolvedFrom: "admin-global",
      userId: req.user.id,
      role: req.user.role,
      plan: "global",
      suspended: false,
      restricted: false,
      scope: {
        isAdmin: true,
        isManager: false,
        isCompany: false,
        isIndividual: false,
      },
    };

    return next();
  }

  /* =====================================================
     TENANT ENFORCEMENT
  ===================================================== */

  if (companyId) {

    const company =
      (db.companies || []).find(c => c.id === companyId);

    if (!company) {
      return res.status(404).json({
        error: "Company not found",
      });
    }

    // Hard suspension
    if (company.status === "Suspended") {
      return res.status(403).json({
        error: "Company suspended",
      });
    }

    const isRestricted = company.status === "Restricted";

    req.tenant = {
      id: companyId,
      type: "tenant",
      brainKey: `tenant:${companyId}`,
      resolvedFrom,
      userId: req.user.id,
      role: req.user.role,
      plan: company.tier || "micro",
      suspended: false,
      restricted: isRestricted,
      scope: {
        isAdmin,
        isManager: role === "manager",
        isCompany: role === "company",
        isIndividual: role === "individual",
      },
    };
  }

  return next();
}

module.exports = tenantMiddleware;
