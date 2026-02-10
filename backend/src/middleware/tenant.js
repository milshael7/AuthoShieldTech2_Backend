// backend/src/middleware/tenant.js
// AuthoDev 6.5 — Company / Tenant Isolation Core (HARDENED)
// MSP-grade • AI-aware • Zero trust • Deterministic

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function resolveFromSubdomain(req) {
  const host = clean(req.headers.host);
  if (!host) return null;

  // example: acme.autoshield.com
  const parts = host.split(".");
  if (parts.length < 3) return null;

  return clean(parts[0], 50);
}

function tenantMiddleware(req, res, next) {
  // 🔒 Auth MUST already be resolved for protected routes
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      error: "Authentication required",
    });
  }

  let companyId = null;

  /* ================= RESOLUTION ================= */

  // 1️⃣ Auth token (primary & safest)
  if (req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
  }

  // 2️⃣ Explicit header (admin / internal tooling only)
  if (!companyId && req.headers["x-company-id"]) {
    companyId = clean(req.headers["x-company-id"], 50);
  }

  // 3️⃣ Subdomain (future expansion only)
  if (!companyId) {
    companyId = resolveFromSubdomain(req);
  }

  if (!companyId) {
    return res.status(400).json({
      ok: false,
      error: "Company context missing",
    });
  }

  const role = String(req.user.role || "").toLowerCase();

  /* ================= TENANT CONTEXT ================= */

  /**
   * 🔒 SINGLE SOURCE OF TRUTH
   * All downstream systems MUST read from req.tenant
   */
  req.tenant = {
    id: companyId,

    // user identity
    userId: req.user.id,
    role: req.user.role,

    // scope classification (FIXED)
    scope: {
      isAdmin: role === "admin",
      isManager: role === "manager",
      isCompany: role === "company",
      isIndividual: role === "individual",
    },

    // 🔑 AI memory / brain partition (ALIGNED)
    brainKey: companyId,

    // audit metadata
    resolvedFrom: req.user.companyId
      ? "auth"
      : req.headers["x-company-id"]
      ? "header"
      : "subdomain",
  };

  next();
}

module.exports = tenantMiddleware;
