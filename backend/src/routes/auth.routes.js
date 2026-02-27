// backend/src/routes/auth.routes.js
// Enterprise Auth Engine — Device Bound v5 (Refresh hardened)
// Session Controlled • Device Fingerprint Bound • TokenVersioned • Company/Sub Guard • Anti-Hijack Ready

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const router = express.Router();

const { sign, verify } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");

// NOTE: keep these imports if your project uses sessionStore.
// If your project uses sessionAdapter instead, swap the import accordingly.
const { revokeToken, revokeAllUserSessions } = require("../lib/sessionStore");

const { buildFingerprint, classifyDeviceRisk } = require("../lib/deviceFingerprint");
const users = require("../users/user.service");

const MAX_LOGIN_ATTEMPTS = 5;
const DEVICE_STRICT = process.env.DEVICE_BINDING_STRICT === "true";

/* ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function safeDelay() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

function ensureJwtSecret(res) {
  if (!process.env.JWT_SECRET) {
    res.status(500).json({ ok: false, error: "Server misconfigured" });
    return false;
  }
  return true;
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function isBillingRoute(req) {
  return req.originalUrl.startsWith("/api/billing");
}

/* ================= BEARER TOKEN HELPERS ================= */

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireAccessPayload(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Missing token" });
    return null;
  }

  try {
    const payload = verify(token, "access");
    if (!payload?.id || !payload?.jti) {
      res.status(401).json({ ok: false, error: "Invalid token" });
      return null;
    }
    return payload;
  } catch {
    res.status(401).json({ ok: false, error: "Invalid token" });
    return null;
  }
}

/* =========================================================
   LOGIN ATTEMPTS
========================================================= */

function recordFailedLogin(user) {
  updateDb((db) => {
    const u = (db.users || []).find((x) => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.failedLogins = (u.securityFlags.failedLogins || 0) + 1;

    if (u.securityFlags.failedLogins >= MAX_LOGIN_ATTEMPTS) {
      u.locked = true;

      audit({
        actor: u.id,
        role: u.role,
        action: "ACCOUNT_AUTO_LOCKED_LOGIN_ABUSE",
      });
    }

    u.updatedAt = nowIso();
    return db;
  });
}

function recordSuccessfulLogin(user, fingerprint) {
  updateDb((db) => {
    const u = (db.users || []).find((x) => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.failedLogins = 0;
    u.lastLoginAt = nowIso();

    // Kill previous sessions by tokenVersion bump
    u.tokenVersion = (u.tokenVersion || 0) + 1;

    // Store device fingerprint
    const previous = u.activeDeviceFingerprint;
    u.activeDeviceFingerprint = fingerprint;

    if (previous && previous !== fingerprint) {
      audit({
        actor: u.id,
        role: u.role,
        action: "DEVICE_CHANGED",
      });
    }

    u.updatedAt = nowIso();
    return db;
  });

  audit({
    actor: user.id,
    role: user.role,
    action: "LOGIN_SUCCESS",
  });
}

/* ========================================================= */

function safeUserResponse(u) {
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    companyId: u.companyId || null,

    subscriptionStatus: u.subscriptionStatus,
    subscriptionTier: u.subscriptionTier || "free",

    status: u.status,
    mustResetPassword: !!u.mustResetPassword,
    freedomEnabled: !!u.freedomEnabled,
    autoprotectEnabled: !!u.autoprotectEnabled,
  };
}

/* =========================================================
   COMPANY / SUBSCRIPTION VALIDATION (ALIGN WITH auth middleware)
========================================================= */

function enforceUserAndCompanyState(req, res, dbUser) {
  if (!dbUser) {
    res.status(401).json({ ok: false, error: "User not found" });
    return false;
  }

  if (dbUser.locked) {
    res.status(403).json({ ok: false, error: "Account suspended" });
    return false;
  }

  if (dbUser.status !== users.APPROVAL_STATUS.APPROVED) {
    res.status(403).json({ ok: false, error: "Account not approved" });
    return false;
  }

  const userInactive =
    norm(dbUser.subscriptionStatus) === "locked" ||
    norm(dbUser.subscriptionStatus) === "past due" ||
    norm(dbUser.subscriptionStatus) === "past_due";

  if (userInactive && !isBillingRoute(req)) {
    res.status(403).json({ ok: false, error: "Subscription inactive" });
    return false;
  }

  // Company enforcement (if bound)
  const db = readDb();
  if (dbUser.companyId && Array.isArray(db.companies)) {
    const company = db.companies.find(
      (c) => String(c.id) === String(dbUser.companyId)
    );

    if (!company) {
      res.status(403).json({ ok: false, error: "Company not found" });
      return false;
    }

    if (company.status === "Suspended") {
      res.status(403).json({ ok: false, error: "Company suspended" });
      return false;
    }

    const companyInactive =
      norm(company.subscriptionStatus) === "locked" ||
      norm(company.subscriptionStatus) === "past due" ||
      norm(company.subscriptionStatus) === "past_due";

    if (companyInactive && !isBillingRoute(req)) {
      res.status(403).json({ ok: false, error: "Company subscription inactive" });
      return false;
    }
  }

  return true;
}

/* =========================================================
   SIGNUP
========================================================= */

router.post("/signup", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password required" });
    }

    const created = await users.createUser({
      email,
      password,
      role: users.ROLES.INDIVIDUAL,
    });

    audit({
      actor: "system",
      role: "system",
      action: "SIGNUP_CREATED",
      target: created.id,
    });

    return res.status(201).json({
      ok: true,
      message: "Account created. Pending approval.",
      user: safeUserResponse(created),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================
   LOGIN (Device Bound)
========================================================= */

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password required" });
    }

    const u = users.findByEmail(email);

    if (!u) {
      await safeDelay();
      await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalid");
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, u.passwordHash);

    if (!valid) {
      recordFailedLogin(u);
      await safeDelay();
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    if (!enforceUserAndCompanyState(req, res, u)) return;

    if (u.mustResetPassword) {
      return res.status(403).json({ ok: false, error: "Password reset required" });
    }

    const fingerprint = buildFingerprint(req);
    recordSuccessfulLogin(u, fingerprint);

    if (!ensureJwtSecret(res)) return;

    // Guarantee jti exists (middleware expects payload.jti)
    const jti = uid("jti");

    const token = sign(
      {
        id: u.id,
        jti,
        role: u.role,
        companyId: u.companyId || null,
        tokenVersion: u.tokenVersion || 0,
      },
      null,
      "15m"
    );

    return res.json({
      ok: true,
      token,
      user: safeUserResponse(u),
    });
  } catch (e) {
    return res.status(403).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================
   REFRESH (Bearer verified here, device-bound, tokenVersioned)
========================================================= */

router.post("/refresh", (req, res) => {
  try {
    const payload = requireAccessPayload(req, res);
    if (!payload) return;

    const dbUser = users.findById(payload.id);
    if (!enforceUserAndCompanyState(req, res, dbUser)) return;

    // tokenVersion sync check (old tokens can’t refresh)
    if (Number(payload.tokenVersion || 0) !== Number(dbUser.tokenVersion || 0)) {
      // kill the presented token jti so it can't keep retrying
      revokeToken(payload.jti);
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    // Role tamper protection (refresh should never allow role drift)
    if (norm(payload.role) !== norm(dbUser.role)) {
      revokeToken(payload.jti);
      audit({
        actor: dbUser.id,
        role: dbUser.role,
        action: "ACCESS_DENIED_ROLE_TAMPER_DETECTED_REFRESH",
      });
      return res.status(403).json({ ok: false, error: "Privilege mismatch" });
    }

    // Device binding (refresh must match active device)
    const deviceCheck = classifyDeviceRisk(dbUser.activeDeviceFingerprint, req);
    if (!deviceCheck.match && DEVICE_STRICT) {
      revokeAllUserSessions(dbUser.id);
      audit({
        actor: dbUser.id,
        role: dbUser.role,
        action: "REFRESH_DEVICE_VERIFICATION_FAILED",
        metadata: { risk: deviceCheck.risk },
      });
      return res.status(401).json({ ok: false, error: "Device verification failed" });
    }

    if (!ensureJwtSecret(res)) return;

    // Rotate jti on refresh (recommended)
    const newJti = uid("jti");

    const token = sign(
      {
        id: dbUser.id,
        jti: newJti,
        role: dbUser.role,
        companyId: dbUser.companyId || null,
        tokenVersion: dbUser.tokenVersion || 0,
      },
      null,
      "15m"
    );

    audit({
      actor: dbUser.id,
      role: dbUser.role,
      action: "TOKEN_REFRESHED",
    });

    return res.json({
      ok: true,
      token,
      user: safeUserResponse(dbUser),
    });
  } catch (e) {
    return res.status(403).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================
   LOGOUT
========================================================= */

router.post("/logout", authRequired, (req, res) => {
  revokeToken(req.securityContext.jti);
  audit({ actor: req.user.id, role: req.user.role, action: "SESSION_LOGOUT" });
  return res.json({ ok: true });
});

router.post("/logout-all", authRequired, (req, res) => {
  revokeAllUserSessions(req.user.id);

  updateDb((db) => {
    const u = (db.users || []).find((x) => x.id === req.user.id);
    if (u) u.tokenVersion = (u.tokenVersion || 0) + 1;
    return db;
  });

  audit({ actor: req.user.id, role: req.user.role, action: "ALL_SESSIONS_LOGOUT" });
  return res.json({ ok: true });
});

router.post("/admin/force-logout/:userId", authRequired, (req, res) => {
  if (req.user.role !== users.ROLES.ADMIN) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  const { userId } = req.params;
  revokeAllUserSessions(userId);

  updateDb((db) => {
    const u = (db.users || []).find((x) => x.id === userId);
    if (u) u.tokenVersion = (u.tokenVersion || 0) + 1;
    return db;
  });

  audit({
    actor: req.user.id,
    role: req.user.role,
    action: "ADMIN_FORCE_LOGOUT",
    target: userId,
  });

  return res.json({ ok: true });
});

module.exports = router;
