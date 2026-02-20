// backend/src/middleware/auth.js
// Phase 26 — Enterprise Access Governance Layer
// JWT Auth • Subscription Enforcement • Exposure Tier Tagging • Privilege Auditing

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

/* ======================================================
   ROLE CLASSIFICATION
====================================================== */

const ACCESS_TIERS = {
  ADMIN: "ADMIN",
  FINANCE: "FINANCE",
  MANAGER: "MANAGER",
  STANDARD: "STANDARD",
};

function classifyAccessTier(role) {
  const r = String(role || "").toLowerCase();

  if (r === "admin") return ACCESS_TIERS.ADMIN;
  if (r === "finance") return ACCESS_TIERS.FINANCE;
  if (r === "manager") return ACCESS_TIERS.MANAGER;

  return ACCESS_TIERS.STANDARD;
}

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

function isBillingRoute(req) {
  return req.originalUrl.startsWith("/api/billing");
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
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_ACCOUNT_LOCKED",
    });

    return error(res, 403, "Account locked");
  }

  if (user.status !== users.APPROVAL_STATUS.APPROVED) {
    return error(res, 403, "Account not approved");
  }

  /* --------------------------------------------------
     SUBSCRIPTION ENFORCEMENT
  -------------------------------------------------- */

  const subscriptionInactive =
    user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
    user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE;

  if (subscriptionInactive && !isBillingRoute(req)) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_SUBSCRIPTION_INACTIVE",
    });

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

    if (company.status === "Suspended") {
      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ACCESS_DENIED_COMPANY_SUSPENDED",
      });

      return error(res, 403, "Company suspended");
    }
  }

  /* --------------------------------------------------
     ACCESS CONTEXT INJECTION
  -------------------------------------------------- */

  const accessTier = classifyAccessTier(user.role);

  req.user = {
    id: user.id,
    role: user.role,
    companyId: user.companyId || null,
    subscriptionStatus: user.subscriptionStatus,
    status: user.status,
  };

  req.accessContext = {
    tier: accessTier,
    isHighPrivilege:
      accessTier === ACCESS_TIERS.ADMIN ||
      accessTier === ACCESS_TIERS.FINANCE,
    requestedAt: Date.now(),
  };

  /* --------------------------------------------------
     HIGH PRIVILEGE ACCESS TELEMETRY
  -------------------------------------------------- */

  if (req.accessContext.isHighPrivilege) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "HIGH_PRIVILEGE_ACCESS",
      detail: {
        path: req.originalUrl,
        method: req.method,
      },
    });
  }

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

    if (userRole === adminRole && adminAlso) {
      return next();
    }

    if (!allow.has(userRole)) {
      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "ACCESS_DENIED_ROLE_MISMATCH",
        detail: {
          requiredRoles: rawRoles,
          attemptedPath: req.originalUrl,
        },
      });

      return error(res, 403, "Forbidden");
    }

    return next();
  };
}

module.exports = {
  authRequired,
  requireRole,
  ACCESS_TIERS,
};
