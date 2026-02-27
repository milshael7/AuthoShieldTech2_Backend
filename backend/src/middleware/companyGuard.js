// backend/src/middleware/companyGuard.js
// Deterministic multi-tenant isolation guard
// Aligned with Master Plan:
// Resolution Order:
//   1. Token companyId (authoritative for non-admin)
//   2. Admin header override (optional)
//   3. Subdomain resolution (already handled in tenant.middleware)

module.exports = function companyGuard(req, res, next) {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const role = String(user.role || "").toLowerCase();
    const userCompanyId = user.companyId != null ? String(user.companyId) : null;

    // Admin Logic
    if (role === "admin") {
      // Admin may optionally specify context via header
      const headerCompanyIdRaw = req.headers["x-company-id"];
      if (headerCompanyIdRaw) {
        req.companyId = String(headerCompanyIdRaw);
      } else if (req.companyId) {
        // tenant.middleware may already have set it (subdomain resolution)
        req.companyId = String(req.companyId);
      } else {
        // Admin global mode (no company context)
        req.companyId = null;
      }

      return next();
    }

    // Non-admin users MUST have companyId in token
    if (!userCompanyId) {
      return res.status(403).json({
        error: "User not assigned to company",
      });
    }

    // Authoritative source for non-admin = token companyId
    req.companyId = userCompanyId;

    // Optional safety check:
    // If header exists, it must match token companyId
    const headerCompanyIdRaw = req.headers["x-company-id"];
    if (headerCompanyIdRaw) {
      const headerCompanyId = String(headerCompanyIdRaw);
      if (headerCompanyId !== userCompanyId) {
        return res.status(403).json({
          error: "Company access violation",
        });
      }
    }

    return next();

  } catch (err) {
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
};
