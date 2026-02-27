// backend/src/routes/auth.routes.js
// Enterprise Auth Engine — Device Bound v7 (SessionAdapter Unified)
// Session Controlled • Device Fingerprint Bound • TokenVersioned • Rotation Safe • Anti-Hijack Ready

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const router = express.Router();

const { sign, verify } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
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

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

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
   LOGIN
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
      updateDb((db) => {
        const user = db.users.find(x => x.id === u.id);
        if (!user.securityFlags) user.securityFlags = {};
        user.securityFlags.failedLogins = (user.securityFlags.failedLogins || 0) + 1;

        if (user.securityFlags.failedLogins >= MAX_LOGIN_ATTEMPTS) {
          user.locked = true;
        }

        return db;
      });

      await safeDelay();
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    if (u.locked) {
      return res.status(403).json({ ok: false, error: "Account suspended" });
    }

    const fingerprint = buildFingerprint(req);

    let newTokenVersion;

    updateDb((db) => {
      const user = db.users.find(x => x.id === u.id);

      user.tokenVersion = (user.tokenVersion || 0) + 1;
      newTokenVersion = user.tokenVersion;

      user.activeDeviceFingerprint = fingerprint;
      user.lastLoginAt = nowIso();

      if (user.securityFlags) {
        user.securityFlags.failedLogins = 0; // ✅ RESET ON SUCCESS
      }

      return db;
    });

    const jti = uid("jti");

    const token = sign(
      {
        id: u.id,
        jti,
        role: u.role,
        companyId: u.companyId || null,
        tokenVersion: newTokenVersion, // ✅ FIXED
      },
      null,
      "15m"
    );

    audit({
      actor: u.id,
      role: u.role,
      action: "LOGIN_SUCCESS",
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        role: u.role,
        email: u.email,
        companyId: u.companyId || null,
        subscriptionStatus: u.subscriptionStatus,
      },
    });

  } catch (e) {
    return res.status(403).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================
   REFRESH (ROTATION SAFE)
========================================================= */

router.post("/refresh", (req, res) => {
  try {
    const payload = requireAccessPayload(req, res);
    if (!payload) return;

    const dbUser = users.findById(payload.id);
    if (!dbUser) {
      return res.status(401).json({ ok: false, error: "User not found" });
    }

    if (Number(payload.tokenVersion || 0) !== Number(dbUser.tokenVersion || 0)) {
      sessionAdapter.revokeToken(payload.jti);
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    const deviceCheck = classifyDeviceRisk(dbUser.activeDeviceFingerprint, req);

    if (!deviceCheck.match && DEVICE_STRICT) {
      sessionAdapter.revokeAllUserSessions(dbUser.id);
      return res.status(401).json({ ok: false, error: "Device verification failed" });
    }

    // ✅ ROTATE TOKEN
    sessionAdapter.revokeToken(payload.jti);

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
      user: {
        id: dbUser.id,
        role: dbUser.role,
        email: dbUser.email,
        companyId: dbUser.companyId || null,
        subscriptionStatus: dbUser.subscriptionStatus,
      },
    });

  } catch (e) {
    return res.status(403).json({ ok: false, error: e?.message || String(e) });
  }
});

/* =========================================================
   LOGOUT
========================================================= */

router.post("/logout", authRequired, (req, res) => {
  sessionAdapter.revokeToken(req.securityContext.jti);

  audit({
    actor: req.user.id,
    role: req.user.role,
    action: "SESSION_LOGOUT",
  });

  return res.json({ ok: true });
});

router.post("/logout-all", authRequired, (req, res) => {
  sessionAdapter.revokeAllUserSessions(req.user.id);

  updateDb((db) => {
    const u = db.users.find(x => x.id === req.user.id);
    if (u) u.tokenVersion = (u.tokenVersion || 0) + 1;
    return db;
  });

  audit({
    actor: req.user.id,
    role: req.user.role,
    action: "ALL_SESSIONS_LOGOUT",
  });

  return res.json({ ok: true });
});

module.exports = router;
