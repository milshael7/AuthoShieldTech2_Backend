// backend/src/middleware/tenant.js
// AutoShield — Enterprise Tenant Isolation Core (Hardened v6)
// Strict Isolation • Cross-Tenant Detection • Audit Integrated

const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

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

function recordViolation(dbUser, reason, meta = {}) {
  audit({
    actor: dbUser.id,
    role: dbUser.role,
    action: "TENANT_BOUNDARY_VIOLATION",
    metadata: { reason, ...meta },
  });

  updateDb((db) => {
    const u = db.users.find(x => x.id === dbUser.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.tenantViolations =
      (u.securityFlags.tenantViolations || 0) + 1;

    // Auto-lock after 5 violations
    if (u.securityFlags.tenantViolations >= 5) {
      u.locked = true;
      audit({
        actor: u.id,
        role: u.role,
        action: "ACCOUNT_AUTO_LOCKED_TENANT_ABUSE",
      });
    }

    return db;
  });
}

function tenantMiddleware(req, res, next) {
  if (!req.user) return next();

  const db = readDb();
  const role = normRole(req.user.role);
  const isAdmin = role === "admin";

  const dbUser = (db.users || []).find(u => u.id === req.user.id);

  if (!dbUser) {
    return res.status(401).json({ error: "User not found" });
  }

  if (dbUser.locked === true) {
    return res.status(403).json({ error: "Account suspended" });
  }

  let companyId = null;
  let resolvedFrom = null;

  /* =============================
     RESOLUTION ORDER
  ============================== */

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

  /* =============================
     ADMIN GLOBAL MODE
  ============================== */

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
      },
    };
    return next();
  }

  /* =============================
     TENANT ENFORCEMENT
  ============================== */

  if (companyId) {

    const company =
      (db.companies || []).find(c => c.id === companyId);

    if (!company) {
      recordViolation(dbUser, "COMPANY_NOT_FOUND", { companyId });
      return res.status(404).json({ error: "Company not found" });
    }

    if (company.status === "Suspended") {
      return res.status(403).json({
        error: "Company suspended",
      });
    }

    const isRestricted = company.status === "Restricted";

    /* =============================
       OWNERSHIP VALIDATION
    ============================== */

    const userBelongs =
      isAdmin ||
      dbUser.companyId === companyId ||
      (Array.isArray(dbUser.managedCompanies) &&
        dbUser.managedCompanies.includes(companyId));

    if (!userBelongs) {
      recordViolation(dbUser, "CROSS_TENANT_ACCESS_ATTEMPT", {
        attemptedCompany: companyId,
      });

      return res.status(403).json({
        error: "Tenant boundary violation",
      });
    }

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
