// backend/src/middleware/auth.js
// JWT Auth Middleware — Production Hardened
// Graceful token handling + stable refresh

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function extractToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/* ======================================================
   AUTH REQUIRED — STABLE
====================================================== */
function authRequired(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  let payload;

  try {
    payload = verify(token);
  } catch (e) {
    // DO NOT crash
    return res.status(401).json({ error: "Token expired or invalid" });
  }

  if (!payload?.id || !payload?.role) {
    return res.status(401).json({ error: "Invalid token payload" });
  }

  const db = readDb();
  const user = (db.users || []).find((u) => u.id === payload.id);

  if (!user) {
    return res.status(401).json({ error: "User no longer exists" });
  }

  if (user.locked === true) {
    return res.status(403).json({ error: "Account suspended" });
  }

  if (user.companyId && db.companies) {
    const company = db.companies.find(
      (c) => c.id === user.companyId
    );
    if (company?.suspended) {
      return res.status(403).json({ error: "Company suspended" });
    }
  }

  req.user = {
    id: user.id,
    role: user.role,
    companyId: user.companyId || null,
  };

  return next();
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

    if (allow.has(adminRole) && userRole === adminRole) {
      return next();
    }

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
