// ======================================================
// FILE: backend/src/middleware/auth.js
// VERSION: v12.0 (Race-Condition Guard + Defensive Logic)
// ======================================================

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
const DEVICE_RISK_BLOCK_THRESHOLD = 85; // Raised slightly to prevent false positives

/* ======================================================
   HELPERS
====================================================== */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

function error(res, code, message) {
  return res.status(code).json({ ok: false, error: message });
}

function norm(v) { return String(v || "").trim().toLowerCase(); }
function idEq(a, b) { return String(a) === String(b); }
function isInactiveStatus(v) { 
  const s = norm(v); 
  return s === "locked" || s === "past_due" || s === "past due"; 
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

  if (!payload?.id || !payload?.jti) return error(res, 401, "Invalid token payload");
  if (sessionAdapter.isRevoked(payload.jti)) return error(res, 401, "Session revoked");

  // DEFENSIVE: Handle potential DB read failures
  let db;
  try {
    db = readDb() || {};
  } catch (e) {
    console.error("AUTH DB READ ERROR:", e.message);
    return error(res, 500, "Internal authentication error");
  }

  const user = (db.users || []).find(u => idEq(u.id, payload.id));
  if (!user) return error(res, 401, "User no longer exists");

  // Version & Role Sync
  if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) return error(res, 401, "Session expired");
  if (norm(payload.role) !== norm(user.role)) return error(res, 403, "Privilege mismatch");
  if (user.locked === true) return error(res, 403, "Account locked");

  /* ===== STATUS CHECKS (SKIP IN DEV) ===== */
  if (!DEV_AUTH_BYPASS) {
    if (user.status !== users.APPROVAL_STATUS.APPROVED) return error(res, 403, "Account not approved");

    const isBilling = req.originalUrl.startsWith("/api/billing");
    if (isInactiveStatus(user.subscriptionStatus) && !isBilling) return error(res, 403, "Subscription inactive");

    if (user.companyId) {
      const company = (db.companies || []).find(c => idEq(c.id, user.companyId));
      if (!company) return error(res, 403, "Company not found");
      if (company.status === "Suspended") return error(res, 403, "Company suspended");
      if (isInactiveStatus(company.subscriptionStatus) && !isBilling) return error(res, 403, "Company subscription inactive");
    }
  }

  /* ===== DEVICE CHECK (SAFETY FIRST) ===== */
  if (user.activeDeviceFingerprint) {
    try {
      const deviceCheck = classifyDeviceRisk(user.activeDeviceFingerprint, req);
      if (!deviceCheck.match && (DEVICE_STRICT || deviceCheck.score >= DEVICE_RISK_BLOCK_THRESHOLD)) {
        sessionAdapter.revokeAllUserSessions(user.id);
        writeAudit({
          actor: user.id, role: user.role, action: "DEVICE_VERIFICATION_FAILED",
          detail: { riskScore: deviceCheck.score, riskLevel: deviceCheck.risk }
        });
        return error(res, 401, "Device verification failed");
      }
    } catch (e) {
      console.warn("Device check skipped due to error:", e.message);
    }
  }

  /* ===== PRIVILEGE AUTO DOWNGRADE (DEFENSIVE) ===== */
  let effectiveRole = user.role;
  let privilegeDowngraded = false;

  const isHighPrivilege = ["admin", "finance"].includes(norm(user.role));
  
  // Only attempt downgrade if decision data is properly structured
  if (isHighPrivilege && db.brain?.decisions && Array.isArray(db.brain.decisions)) {
    try {
      const recent = db.brain.decisions
        .filter(d => idEq(d.userId, user.id))
        .slice(-15);

      if (recent.length > 0) {
        const criticalCount = recent.filter(d => d.level === "Critical").length;
        const avgScore = recent.reduce((s, v) => s + (v.combinedScore || 0), 0) / recent.length;

        if (criticalCount >= 2 || avgScore >= 75) {
          privilegeDowngraded = true;
          effectiveRole = "restricted_admin";
          writeAudit({
            actor: user.id, role: user.role, action: "PRIVILEGE_AUTO_DOWNGRADE",
            detail: { criticalCount, avgScore }
          });
        }
      }
    } catch (e) {
      console.error("Privilege downgrade logic failed:", e.message);
      // We don't block the user, just log it and continue with original role
    }
  }

  sessionAdapter.registerSession(user.id, payload.jti, ACCESS_TOKEN_TTL_MS);

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

/* ======================================================
   ROLE GUARD
====================================================== */
function requireRole(...roles) {
  const allow = new Set(roles.map(r => norm(r)));
  return (req, res, next) => {
    if (!req.user) return error(res, 401, "Missing auth context");
    if (!allow.has(norm(req.user.role))) return error(res, 403, "Forbidden");
    return next();
  };
}

module.exports = { authRequired, requireRole };
