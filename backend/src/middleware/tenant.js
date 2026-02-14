// backend/src/middleware/tenant.js
// AutoShield — Enterprise Tenant Isolation Core (Hardened v2)

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function resolveFromSubdomain(req) {
  let host = req.hostname || req.headers.host;
  if (!host) return null;

  // Remove port if present
  host = String(host).split(":")[0];

  const parts = host.split(".");
  if (parts.length < 3) return null;

  return clean(parts[0], 50);
}

function tenantMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      error: "Authentication required",
    });
  }

  const role = normRole(req.user.role);
  const isAdmin = role === "admin";

  let companyId = null;
  let resolvedFrom = null;

  /* ================= RESOLUTION ORDER ================= */

  // 1️⃣ Primary: Auth token
  if (req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
    resolvedFrom = "auth";
  }

  // 2️⃣ Admin-only override header
  if (!companyId && isAdmin) {
    const headerCompany = req.headers["x-company-id"];
    if (headerCompany) {
      companyId = clean(headerCompany, 50);
      resolvedFrom = "admin-header";
    }
  }

  // 3️⃣ Subdomain (optional)
  if (!companyId) {
    const sub = resolveFromSubdomain(req);
    if (sub) {
      companyId = sub;
      resolvedFrom = "subdomain";
    }
  }

  /* ================= ADMIN GLOBAL ACCESS ================= */

  if (isAdmin && !companyId) {
    req.tenant = {
      id: null,
      type: "global",
      userId: req.user.id,
      role: req.user.role,
      scope: {
        isAdmin: true,
        isManager: false,
        isCompany: false,
        isIndividual: false,
      },
      brainKey: "global",
      resolvedFrom: "admin-global",
    };

    return next();
  }

  if (!companyId) {
    return res.status(400).json({
      ok: false,
      error: "Company context missing",
    });
  }

  /* ================= TENANT CONTEXT ================= */

  req.tenant = {
    id: companyId,
    type: "tenant",
    userId: req.user.id,
    role: req.user.role,
    scope: {
      isAdmin,
      isManager: role === "manager",
      isCompany: role === "company",
      isIndividual: role === "individual",
    },
    brainKey: companyId,
    resolvedFrom,
  };

  return next();
}

module.exports = tenantMiddleware;
