// backend/src/middleware/auth.js
// Enterprise Access Governance Layer — Zero Trust Core v4
// Token Versioned • JTI Revocation • Device Binding • Subscription Guard • Company Guard

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
const {
  classifyDeviceRisk
} = require("../lib/deviceFingerprint");

const users = require("../users/user.service");

/* ====================================================== */

const DEVICE_STRICT = process.env.DEVICE_BINDING_STRICT === "true";

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
    payload = verify(token, "access");
  } catch {
    return error(res, 401, "Token expired or invalid");
  }

  if (!payload?.id || !payload?.jti) {
    return error(res, 401, "Invalid token payload");
  }

  /* ================= JTI REVOCATION ================= */

  if (sessionAdapter.isRevoked(payload.jti)) {
    writeAudit({
      actor: payload.id,
      role: payload.role,
      action: "ACCESS_DENIED_REVOKED_TOKEN"
    });

    return error(res, 401, "Session revoked");
  }

  const db = readDb();
  const user = (db.users || []).find(u => u.id === payload.id);

  if (!user) {
    return error(res, 401, "User no longer exists");
  }

  /* ================= TOKEN VERSION ================= */

  const tokenVersion = Number(payload.tokenVersion || 0);
  const currentVersion = Number(user.tokenVersion || 0);

  if (tokenVersion !== currentVersion) {

    sessionAdapter.revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_TOKEN_VERSION_MISMATCH"
    });

    return error(res, 401, "Session expired");
  }

  /* ================= ROLE TAMPER ================= */

  if (norm(payload.role) !== norm(user.role)) {

    sessionAdapter.revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_ROLE_TAMPER_DETECTED"
    });

    return error(res, 403, "Privilege mismatch");
  }

  /* ================= ACCOUNT LOCK ================= */

  if (user.locked === true) {

    sessionAdapter.revokeToken(payload.jti);

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

  /* ================= DEVICE BINDING ================= */

  const deviceCheck = classifyDeviceRisk(
    user.activeDeviceFingerprint,
    req
  );

  if (!deviceCheck.match) {

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "DEVICE_MISMATCH_DETECTED",
      detail: { risk: deviceCheck.risk }
    });

    if (DEVICE_STRICT) {
      sessionAdapter.revokeAllUserSessions(user.id);
      return error(res, 401, "Device verification failed");
    }
  }

  /* ================= SUBSCRIPTION ================= */

  const inactive =
    user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
    user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE;

  if (inactive && !isBillingRoute(req)) {

    sessionAdapter.revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_SUBSCRIPTION_INACTIVE"
    });

    return error(res, 403, "Subscription inactive");
  }

  /* ================= COMPANY STATUS ================= */

  if (user.companyId && Array.isArray(db.companies)) {
    const company = db.companies.find(c => c.id === user.companyId);

    if (!company || company.status === "Suspended") {

      sessionAdapter.revokeToken(payload.jti);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ACCESS_DENIED_COMPANY_SUSPENDED"
      });

      return error(res, 403, "Company suspended");
    }
  }

  /* ================= REGISTER SESSION ================= */

  sessionAdapter.registerSession(user.id, payload.jti);

  /* ================= CONTEXT ================= */

  req.user = {
    id: user.id,
    role: user.role,
    companyId: user.companyId || null,
    subscriptionStatus: user.subscriptionStatus
  };

  req.securityContext = {
    tokenVersion,
    jti: payload.jti,
    verifiedAt: Date.now(),
    highPrivilege:
      norm(user.role) === "admin" ||
      norm(user.role) === "finance"
  };

  /* ================= HIGH PRIVILEGE AUDIT ================= */

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
