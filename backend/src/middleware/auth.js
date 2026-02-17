// backend/src/middleware/auth.js
// JWT Auth Middleware — Phase 5 Hardened
// Token validation + DB recheck + Suspension enforcement

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

/* ======================================================
   AUTH REQUIRED — HARD VALIDATION
====================================================== */
function authRequired(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = verify(token);

    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.id !== "string" ||
      typeof payload.role !== "string"
    ) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // 🔒 RE-VALIDATE USER AGAINST DATABASE
    const db = readDb();
    const user = (db.users || []).find((u) => u.id === payload.id);

    if (!user) {
      return res.status(401).json({ error: "User no longer exists" });
    }

    if (user.locked === true) {
      return res.status(403).json({ error: "Account suspended" });
    }

    // Optional: if company suspended
    if (user.companyId && db.companies) {
      const company = db.companies.find(c => c.id === user.companyId);
      if (company?.suspended) {
        return res.status(403).json({ error: "Company suspended" });
      }
    }

    // Attach sanitized user context
    req.user = {
      id: user.id,
      role: user.role,
      companyId: user.companyId || null,
    };

    return next();

  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ======================================================
   ROLE GUARD
====================================================== */

function requireRole(...args) {
  let opts = {};

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

    // Admin explicitly allowed
    if (allow.has(adminRole) && userRole === adminRole) {
      return next();
    }

    // Optional admin override
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
