// backend/src/middleware/auth.js
// Enterprise Access Governance Layer — Hardened v3
// Token Versioned • Role Locked • Subscription Enforced • Replay Resistant

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const users = require("../users/user.service");

/* ====================================================== */

function extractToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

function error(res, code, message) {
  return res.status(code).json({ ok: false, error: message });
}

function isBillingRoute(req) {
  return req.originalUrl.startsWith("/api/billing");
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

/* ======================================================
   AUTH REQUIRED
====================================================== */

function authRequired(req, res, next) {
  const token = extractToken(req);
  if (!token) return error(res, 401, "Missing token");

  let payload;
  try {
    payload = verify(token);
  } catch {
    return error(res, 401, "Token expired or invalid");
  }

  if (!payload?.id) {
    return error(res, 401, "Invalid token payload");
  }

  const db = readDb();
  const user = (db.users || []).find(u => u.id === payload.id);

  if (!user) {
    return error(res, 401, "User no longer exists");
  }

  /* ======================================================
     TOKEN VERSION ENFORCEMENT
  ====================================================== */

  const tokenVersion = Number(payload.tokenVersion || 0);
  const currentVersion = Number(user.tokenVersion || 0);

  if (tokenVersion !== currentVersion) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_TOKEN_VERSION_MISMATCH"
    });

    return error(res, 401, "Session expired");
  }

  /* ======================================================
     ROLE MISMATCH PROTECTION
  ====================================================== */

  if (norm(payload.role) !== norm(user.role)) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_ROLE_TAMPER_DETECTED"
    });

    return error(res, 403, "Privilege mismatch");
  }

  /* ======================================================
     ACCOUNT LOCK
  ====================================================== */

  if (user.locked === true) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_ACCOUNT_LOCKED"
    });

    return error(res, 403, "Account locked");
  }

  if (user.status !== users.APPROVAL_STATUS.APPROVED) {
    return error(res, 403, "Account not approved");
  }

  /* ======================================================
     SUBSCRIPTION ENFORCEMENT
  ====================================================== */

  const inactive =
    user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
    user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE;

  if (inactive && !isBillingRoute(req)) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_SUBSCRIPTION_INACTIVE"
    });

    return error(res, 403, "Subscription inactive");
  }

  /* ======================================================
     COMPANY STATUS
  ====================================================== */

  if (user.companyId && Array.isArray(db.companies)) {
    const company = db.companies.find(c => c.id === user.companyId);

    if (!company) {
      return error(res, 403, "Company not found");
    }

    if (company.status === "Suspended") {
      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ACCESS_DENIED_COMPANY_SUSPENDED"
      });

      return error(res, 403, "Company suspended");
    }
  }

  /* ======================================================
     ACCESS CONTEXT
  ====================================================== */

  req.user = {
    id: user.id,
    role: user.role,
    companyId: user.companyId || null,
    subscriptionStatus: user.subscriptionStatus
  };

  req.securityContext = {
    tokenVersion,
    verifiedAt: Date.now(),
    highPrivilege:
      norm(user.role) === "admin" ||
      norm(user.role) === "finance"
  };

  /* ======================================================
     HIGH PRIVILEGE TELEMETRY
  ====================================================== */

  if (req.securityContext.highPrivilege) {
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "HIGH_PRIVILEGE_ACCESS",
      detail: {
        path: req.originalUrl,
        method: req.method
      }
    });
  }

  return next();
}

/* ======================================================
   ROLE GUARD
====================================================== */

function requireRole(...roles) {
  const allow = new Set(roles.map(r => norm(r)));

  return (req, res, next) => {
    if (!req.user) {
      return error(res, 401, "Missing auth context");
    }

    if (!allow.has(norm(req.user.role))) {
      writeAudit({
        actor: req.user.id,
        role: req.user.role,
        action: "ACCESS_DENIED_ROLE_MISMATCH",
        detail: { path: req.originalUrl }
      });

      return error(res, 403, "Forbidden");
    }

    return next();
  };
}

module.exports = {
  authRequired,
  requireRole
};
