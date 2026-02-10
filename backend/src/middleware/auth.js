// backend/src/middleware/auth.js
// JWT auth middleware used by protected routes (Admin / Manager / Company gates)

const { verify } = require("../auth/jwt");

/* ======================================================
   AUTH REQUIRED
   ====================================================== */
function authRequired(req, res, next) {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ")
    ? h.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = verify(token, process.env.JWT_SECRET);

    // 🔒 Hard validation of token payload
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.role !== "string"
    ) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ======================================================
   ROLE GUARD
   ====================================================== */

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

/**
 * requireRole('Admin','Manager')
 * requireRole(['Admin','Manager'])
 * requireRole('Manager', { adminAlso: true })
 */
function requireRole(...args) {
  let opts = {};

  // options object as last argument
  if (
    args.length &&
    typeof args[args.length - 1] === "object" &&
    !Array.isArray(args[args.length - 1])
  ) {
    opts = args.pop() || {};
  }

  const rawRoles = args.flat().filter(Boolean);
  const allow = new Set(rawRoles.map(normRole));

  const adminRole = normRole(opts.adminRole || "Admin");
  const adminAlso = !!opts.adminAlso;

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Missing auth" });
    }

    const userRole = normRole(req.user.role);

    // ✅ Admin always allowed if explicitly listed
    if (allow.has(adminRole) && userRole === adminRole) {
      return next();
    }

    // ✅ Optional admin override
    if (adminAlso && userRole === adminRole) {
      return next();
    }

    if (!allow.has(userRole)) {
      return res.status(403).json({
        error: "Forbidden",
        role: req.user.role,
        allowed: Array.from(allow),
      });
    }

    return next();
  };
}

module.exports = { authRequired, requireRole };
