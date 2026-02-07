// backend/src/middleware/tenant.js
// STEP 20 — Company / Tenant Isolation Core
// AuthoDev 6.5 • MSP-grade • Non-resetting context

/**
 * HOW IT WORKS
 * - Determines which company (tenant) the request belongs to
 * - Attaches req.tenant for ALL downstream logic
 * - Used by AI, security, trading, dashboards
 *
 * Tenant can be resolved via:
 * 1) Auth token (preferred)
 * 2) x-company-id header (admin / API)
 * 3) subdomain (future-ready)
 */

function clean(v, max = 100) {
  return String(v || "").trim().slice(0, max);
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
  let companyId = null;

  // 1️⃣ From authenticated user (recommended)
  if (req.user && req.user.companyId) {
    companyId = clean(req.user.companyId, 50);
  }

  // 2️⃣ From explicit header (API / admin tools)
  if (!companyId && req.headers["x-company-id"]) {
    companyId = clean(req.headers["x-company-id"], 50);
  }

  // 3️⃣ From subdomain (future)
  if (!companyId) {
    companyId = resolveFromSubdomain(req);
  }

  if (!companyId) {
    return res.status(400).json({
      ok: false,
      error: "Company context missing",
      hint: "Authenticate or provide x-company-id",
    });
  }

  /**
   * 🔒 ATTACHED TENANT CONTEXT
   * Everything downstream reads from req.tenant
   */
  req.tenant = {
    id: companyId,
    role: req.user?.role || "user",
    userId: req.user?.id || null,
  };

  next();
}

module.exports = tenantMiddleware;
