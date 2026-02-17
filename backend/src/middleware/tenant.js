// backend/src/middleware/tenant.js
// AutoShield — Enterprise Tenant Isolation Core (Hardened v3)

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

  // Ignore localhost & IP addresses
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

  // 🔒 DO NOT force auth here
  // Auth middleware handles protection
  if (!req.user) {
    return next();
  }

  const role = normRole(req.user.role);
  const isAdmin = role === "admin";

  let companyId = null;
  let resolvedFrom = null;

  /* ================= RESOLUTION ORDER ================= */

  // 1️⃣ Auth token companyId
  if (req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
    resolvedFrom = "auth";
  }

  // 2️⃣ Admin override header
  if (!companyId && isAdmin) {
    const headerCompany = req.headers["x-company-id"];
    if (headerCompany) {
      companyId = clean(headerCompany, 50);
      resolvedFrom = "admin-header";
    }
  }

  // 3️⃣ Subdomain
  if (!companyId) {
    const sub = resolveFromSubdomain(req);
    if (sub) {
      companyId = sub;
      resolvedFrom = "subdomain";
    }
  }

  /* ================= GLOBAL ADMIN ================= */

  if (isAdmin && !companyId) {
    req.tenant = {
      id: null,
      type: "global",
      brainKey: "global",
      resolvedFrom: "admin-global",
      userId: req.user.id,
      role: req.user.role,
      scope: {
        isAdmin: true,
        isManager: false,
        isCompany: false,
        isIndividual: false,
      },
    };

    return next();
  }

  /* ================= TENANT CONTEXT ================= */

  if (companyId) {
    req.tenant = {
      id: companyId,
      type: "tenant",
      brainKey: `tenant:${companyId}`, // normalized
      resolvedFrom,
      userId: req.user.id,
      role: req.user.role,
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
