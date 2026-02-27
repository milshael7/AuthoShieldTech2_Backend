// backend/src/middleware/auth.js
// AutoShield Tech — Zero Trust Identity Firewall v9
// Token Versioned • Replay Safe • Device Risk Scored • Subscription Guard
// Company Guard • Privilege Auto-Downgrade • Dev Override Safe • Audit Logged

const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const sessionAdapter = require("../lib/sessionAdapter");
const { classifyDeviceRisk } = require("../lib/deviceFingerprint");
const { writeAudit } = require("../lib/audit");

const users = require("../users/user.service");

/* ====================================================== */

const DEVICE_STRICT = process.env.DEVICE_BINDING_STRICT === "true";
const DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS === "true";
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEVICE_RISK_BLOCK_THRESHOLD = 70;

const PRIVILEGE_ACCELERATION_WINDOW = 15;
const PRIVILEGE_CRITICAL_THRESHOLD = 2;
const PRIVILEGE_AVG_SCORE_THRESHOLD = 75;

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

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function idEq(a, b) {
  return String(a) === String(b);
}

function isInactiveStatus(v) {
  const s = norm(v);
  return s === "locked" || s === "past_due" || s === "past due";
}

function isBillingRoute(req) {
  return req.originalUrl.startsWith("/api/billing");
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
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

  if (sessionAdapter.isRevoked(payload.jti)) {
    return error(res, 401, "Session revoked");
  }

  const db = readDb();
  const user = (db.users || []).find(u => idEq(u.id, payload.id));
  if (!user) return error(res, 401, "User no longer exists");

  /* ================= TOKEN VERSION ================= */

  if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
    sessionAdapter.revokeToken(payload.jti);
    return error(res, 401, "Session expired");
  }

  /* ================= ROLE TAMPER ================= */

  if (norm(payload.role) !== norm(user.role)) {
    sessionAdapter.revokeToken(payload.jti);
    return error(res, 403, "Privilege mismatch");
  }

  /* ================= ACCOUNT LOCK ================= */

  if (user.locked === true) {
    sessionAdapter.revokeToken(payload.jti);
    return error(res, 403, "Account locked");
  }

  /* ======================================================
     🔥 DEV AUTH BYPASS (CONTROLLED)
     Only active if DEV_AUTH_BYPASS=true
  ====================================================== */

  if (!DEV_AUTH_BYPASS) {

    if (user.status !== users.APPROVAL_STATUS.APPROVED) {
      return error(res, 403, "Account not approved");
    }

    if (isInactiveStatus(user.subscriptionStatus) && !isBillingRoute(req)) {
      return error(res, 403, "Subscription inactive");
    }

    if (user.companyId && Array.isArray(db.companies)) {

      const company = db.companies.find(
        c => idEq(c.id, user.companyId)
      );

      if (!company) return error(res, 403, "Company not found");

      if (company.status === "Suspended") {
        return error(res, 403, "Company suspended");
      }

      if (isInactiveStatus(company.subscriptionStatus) && !isBillingRoute(req)) {
        return error(res, 403, "Company subscription inactive");
      }
    }
  }

  /* ================= DEVICE BINDING ================= */

  const deviceCheck = classifyDeviceRisk(
    user.activeDeviceFingerprint,
    req
  );

  if (!deviceCheck.match) {

    if (DEVICE_STRICT || deviceCheck.score >= DEVICE_RISK_BLOCK_THRESHOLD) {

      sessionAdapter.revokeAllUserSessions(user.id);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "DEVICE_VERIFICATION_FAILED",
        detail: {
          riskScore: deviceCheck.score,
          riskLevel: deviceCheck.risk
        }
      });

      return error(res, 401, "Device verification failed");
    }
  }

  /* ======================================================
     🔥 AUTONOMOUS PRIVILEGE DOWNGRADE
  ====================================================== */

  let effectiveRole = user.role;
  let privilegeDowngraded = false;

  const isHighPrivilege =
    norm(user.role) === "admin" ||
    norm(user.role) === "finance";

  if (isHighPrivilege) {

    const decisions = db.brain?.decisions || [];

    const recent = decisions
      .filter(d => d.userId === user.id)
      .slice(-PRIVILEGE_ACCELERATION_WINDOW);

    const criticalCount = recent.filter(
      d => d.level === "Critical"
    ).length;

    const avgScore = average(
      recent.map(d => d.combinedScore)
    );

    const accelerationFlag = recent.some(
      d => d.accelerationDetected === true
    );

    if (
      criticalCount >= PRIVILEGE_CRITICAL_THRESHOLD ||
      avgScore >= PRIVILEGE_AVG_SCORE_THRESHOLD ||
      accelerationFlag
    ) {

      privilegeDowngraded = true;
      effectiveRole = "restricted_admin";

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "PRIVILEGE_AUTO_DOWNGRADE",
        detail: {
          criticalCount,
          avgScore,
          accelerationFlag
        }
      });
    }
  }

  /* ================= REGISTER SESSION ================= */

  sessionAdapter.registerSession(
    user.id,
    payload.jti,
    ACCESS_TOKEN_TTL_MS
  );

  req.user = {
    id: user.id,
    role: effectiveRole,
    originalRole: user.role,
    privilegeDowngraded,
    companyId: user.companyId || null,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionTier: user.subscriptionTier || "free"
  };

  return next();
}

module.exports = {
  authRequired
};
