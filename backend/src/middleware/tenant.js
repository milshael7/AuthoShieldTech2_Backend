// backend/src/middleware/tenant.js
// AutoShield Tech — Enterprise Tenant Isolation Core v9
// Token Authoritative • Admin Scoped • Slug Safe • Cross-Tenant Guard • Audit Escalated

const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function idEq(a, b) {
  return String(a) === String(b);
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
    detail: { reason, ...meta },
  });

  updateDb((db) => {
    const u = db.users.find(x => idEq(x.id, dbUser.id));
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.tenantViolations =
      (u.securityFlags.tenantViolations || 0) + 1;

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

  const dbUser = (db.users || []).find(u => idEq(u.id, req.user.id));

  if (!dbUser) {
    return res.status(401).json({ error: "User not found" });
  }

  if (dbUser.locked === true) {
    return res.status(403).json({ error: "Account suspended" });
  }

  let companyId = null;
  let resolvedFrom = null;

  /* =====================================================
     STRICT RESOLUTION ORDER
     1. Token companyId (authoritative, immutable)
     2. Admin header override (validated)
     3. Subdomain resolution (validated, admin only)
  ===================================================== */

  // 1️⃣ TOKEN AUTHORITY (non-admin immutable)
  if (!isAdmin && req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
    resolvedFrom = "auth-token";
  }

  // 2️⃣ ADMIN HEADER OVERRIDE (validated existence)
  if (isAdmin && req.headers["x-company-id"]) {
    const headerCompany = clean(req.headers["x-company-id"], 50);

    const exists = (db.companies || []).some(c =>
      idEq(c.id, headerCompany)
    );

    if (!exists) {
      return res.status(404).json({ error: "Company not found" });
    }

    companyId = headerCompany;
    resolvedFrom = "admin-header";
  }

  // 3️⃣ SUBDOMAIN (admin fallback only, validated)
  if (isAdmin && !companyId) {
    const sub = resolveFromSubdomain(req);

    if (sub) {
      const company = (db.companies || []).find(
        c => idEq(c.slug, sub) || idEq(c.id, sub)
      );

      if (company) {
        companyId = company.id;
        resolvedFrom = "subdomain";
      }
    }
  }

  /* =====================================================
     ADMIN GLOBAL MODE
  ===================================================== */

  if (isAdmin && !companyId) {
    req.companyId = null;
    req.tenant = {
      id: null,
      type: "global",
      resolvedFrom: "admin-global",
      userId: req.user.id,
      role: req.user.role,
      plan: "global",
      suspended: false,
      restricted: false,
      scope: { isAdmin: true },
    };
    return next();
  }

  /* =====================================================
     TENANT REQUIRED
  ===================================================== */

  if (!companyId) {
    return res.status(403).json({
      error: "Tenant context required",
    });
  }

  const company =
    (db.companies || []).find(c => idEq(c.id, companyId));

  if (!company) {
    recordViolation(dbUser, "COMPANY_NOT_FOUND", { companyId });
    return res.status(404).json({ error: "Company not found" });
  }

  const isSuspended = company.status === "Suspended";
  const isRestricted = company.status === "Restricted";

  if (isSuspended) {
    audit({
      actor: dbUser.id,
      role: dbUser.role,
      action: "SUSPENDED_COMPANY_ACCESS_ATTEMPT",
      detail: { companyId }
    });

    return res.status(403).json({
      error: "Company suspended",
    });
  }

  /* =====================================================
     OWNERSHIP VALIDATION
  ===================================================== */

  const userBelongs =
    isAdmin ||
    idEq(dbUser.companyId, companyId) ||
    (Array.isArray(dbUser.managedCompanies) &&
      dbUser.managedCompanies.some(id => idEq(id, companyId)));

  if (!userBelongs) {
    recordViolation(dbUser, "CROSS_TENANT_ACCESS_ATTEMPT", {
      attemptedCompany: companyId,
    });

    return res.status(403).json({
      error: "Tenant boundary violation",
    });
  }

  /* =====================================================
     CONTEXT FREEZE
  ===================================================== */

  req.companyId = String(companyId);

  req.tenant = {
    id: String(companyId),
    type: "tenant",
    resolvedFrom,
    userId: req.user.id,
    role: req.user.role,
    plan: company.tier || "micro",
    suspended: isSuspended,
    restricted: isRestricted,
    scope: {
      isAdmin,
      isManager: role === "manager",
      isCompany: role === "company",
      isIndividual: role === "individual",
      isSmallCompany: role === "small_company",
    },
  };

  return next();
}

module.exports = tenantMiddleware;
