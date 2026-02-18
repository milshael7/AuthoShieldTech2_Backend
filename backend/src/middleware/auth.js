// backend/src/middleware/auth.js
// JWT Auth Middleware — Enterprise Hardened • Tier Enforced • Approval Safe

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");

/* ======================================================
   HELPERS
====================================================== */

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

function error(res, code, message) {
  return res.status(code).json({
    ok: false,
    error: message,
  });
}

/* ======================================================
   AUTH REQUIRED
====================================================== */

function authRequired(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return error(res, 401, "Missing token");
  }

  let payload;

  try {
    payload = verify(token);
  } catch {
    return error(res, 401, "Token expired or invalid");
  }

  if (!payload?.id || !payload?.role) {
    return error(res, 401, "Invalid token payload");
  }

  const db = readDb();
  const user = (db.users || []).find((u) => u.id === payload.id);

  if (!user) {
    return error(res, 401, "User no longer exists");
  }

  /* --------------------------------------------------
     USER STATUS ENFORCEMENT
  -------------------------------------------------- */

  if (user.locked === true) {
    return error(res, 403, "Account locked");
  }

  if (user.status !== users.APPROVAL_STATUS.APPROVED) {
    return error(res, 403, "Account not approved");
  }

  if (
    user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
    user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE
  ) {
    return error(res, 403, "Subscription inactive");
  }

  /* --------------------------------------------------
     COMPANY STATUS ENFORCEMENT
  -------------------------------------------------- */

  if (user.companyId && Array.isArray(db.companies)) {
    const company = db.companies.find(
      (c) => c.id === user.companyId
    );

    if (!company) {
      return error(res, 403, "Company not found");
    }

    if (company.status !== "Active") {
      return error(res, 403, "Company not active");
    }
  }

  /* --------------------------------------------------
     ATTACH CLEAN CONTEXT
  -------------------------------------------------- */

  req.user = {
    id: user.id,
    role: user.role,
    companyId: user.companyId || null,
    subscriptionStatus: user.subscriptionStatus,
    status: user.status,
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
      return error(res, 401, "Missing auth context");
    }

    const userRole = normRole(req.user.role);

    // direct admin access
    if (userRole === adminRole && adminAlso) {
      return next();
    }

    if (!allow.has(userRole)) {
      return error(res, 403, "Forbidden");
    }

    return next();
  };
}

module.exports = {
  authRequired,
  requireRole,
};
