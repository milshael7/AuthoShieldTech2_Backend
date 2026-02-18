// backend/src/middleware/companyGuard.js
// Enforces strict company isolation

module.exports = function companyGuard(req, res, next) {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Admin can access everything
    if (String(user.role).toLowerCase() === "admin") {
      return next();
    }

    const headerCompanyId = req.headers["x-company-id"];
    const userCompanyId = user.companyId;

    if (!userCompanyId) {
      return res.status(403).json({
        error: "User not assigned to company",
      });
    }

    // Must match
    if (!headerCompanyId || headerCompanyId !== userCompanyId) {
      return res.status(403).json({
        error: "Company access violation",
      });
    }

    next();

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
};
