// backend/src/middleware/auth.js
// Enterprise Access Governance Layer — Device Bound Zero Trust
// Token Versioned • JTI Revocation • Replay Guard • Device Binding Enforced

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const {
  registerSession,
  revokeToken,
  isRevoked
} = require("../lib/sessionStore");

const {
  buildFingerprint,
  classifyDeviceRisk
} = require("../lib/deviceFingerprint");

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

  if (!payload?.id || !payload?.jti) {
    return error(res, 401, "Invalid token payload");
  }

  /* ================= JTI REVOCATION ================= */

  if (isRevoked(payload.jti)) {
    writeAudit({
      actor: payload.id,
      role: payload.role,
      action: "ACCESS_DENIED_REVOKED_TOKEN",
      detail: { jti: payload.jti }
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

    revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_TOKEN_VERSION_MISMATCH"
    });

    return error(res, 401, "Session expired");
  }

  /* ================= ROLE TAMPER ================= */

  if (norm(payload.role) !== norm(user.role)) {

    revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_ROLE_TAMPER_DETECTED"
    });

    return error(res, 403, "Privilege mismatch");
  }

  /* ================= DEVICE BINDING ================= */

  const deviceCheck = classifyDeviceRisk(
    user.activeDeviceFingerprint,
    req
  );

  if (!deviceCheck.match) {

    revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "DEVICE_MISMATCH_DETECTED",
      detail: { risk: deviceCheck.risk }
    });

    return error(res, 401, "Device verification failed");
  }

  /* ================= ACCOUNT STATUS ================= */

  if (user.locked === true) {
    revokeToken(payload.jti);

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

  /* ================= SUBSCRIPTION ================= */

  const inactive =
    user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
    user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE;

  if (inactive && !isBillingRoute(req)) {
    revokeToken(payload.jti);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ACCESS_DENIED_SUBSCRIPTION_INACTIVE"
    });

    return error(res, 403, "Subscription inactive");
  }

  /* ================= COMPANY ================= */

  if (user.companyId && Array.isArray(db.companies)) {
    const company = db.companies.find(c => c.id === user.companyId);

    if (!company || company.status === "Suspended") {

      revokeToken(payload.jti);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ACCESS_DENIED_COMPANY_SUSPENDED"
      });

      return error(res, 403, "Company suspended");
    }
  }

  /* ================= REGISTER SESSION ================= */

  registerSession(user.id, payload.jti);

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

  /* ================= HIGH PRIVILEGE LOG ================= */

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
