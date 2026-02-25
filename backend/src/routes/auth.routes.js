// backend/src/routes/auth.routes.js
// Enterprise Auth Engine — Hardened v2
// Anti-Brute Force • Audited • Token Versioned • Enumeration Resistant

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const { sign } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");

const MAX_LOGIN_ATTEMPTS = 5;

/* ========================================================= */

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function safeDelay() {
  return new Promise(resolve => setTimeout(resolve, 400));
}

function ensureJwtSecret(res) {
  if (!process.env.JWT_SECRET) {
    res.status(500).json({
      error: "Server misconfigured"
    });
    return false;
  }
  return true;
}

/* =========================================================
   LOGIN ATTEMPT HANDLING
========================================================= */

function recordFailedLogin(user) {
  updateDb((db) => {
    const u = db.users.find(x => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.failedLogins =
      (u.securityFlags.failedLogins || 0) + 1;

    if (u.securityFlags.failedLogins >= MAX_LOGIN_ATTEMPTS) {
      u.locked = true;

      audit({
        actor: u.id,
        role: u.role,
        action: "ACCOUNT_AUTO_LOCKED_LOGIN_ABUSE"
      });
    }

    u.updatedAt = new Date().toISOString();
    return db;
  });
}

function recordSuccessfulLogin(user) {
  updateDb((db) => {
    const u = db.users.find(x => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.failedLogins = 0;
    u.lastLoginAt = new Date().toISOString();
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    u.updatedAt = new Date().toISOString();

    return db;
  });

  audit({
    actor: user.id,
    role: user.role,
    action: "LOGIN_SUCCESS"
  });
}

/* =========================================================
   SAFE USER RESPONSE
========================================================= */

function safeUserResponse(u) {
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    companyId: u.companyId || null,
    subscriptionStatus: u.subscriptionStatus,
    status: u.status,
    mustResetPassword: !!u.mustResetPassword,
    freedomEnabled: !!u.freedomEnabled,
    autoprotectEnabled: !!u.autoprotectEnabled,
  };
}

/* =========================================================
   SIGNUP
========================================================= */

router.post("/signup", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required"
      });
    }

    const created = await users.createUser({
      email,
      password,
      role: users.ROLES.INDIVIDUAL
    });

    audit({
      actor: "system",
      role: "system",
      action: "SIGNUP_CREATED",
      target: created.id
    });

    return res.status(201).json({
      ok: true,
      message: "Account created. Pending approval.",
      user: safeUserResponse(created)
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e)
    });
  }
});

/* =========================================================
   LOGIN
========================================================= */

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required"
      });
    }

    const u = users.findByEmail(email);

    if (!u) {
      await safeDelay();
      await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalid");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, u.passwordHash);

    if (!valid) {
      recordFailedLogin(u);
      await safeDelay();
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (u.locked === true) {
      return res.status(403).json({ error: "Account suspended" });
    }

    if (u.mustResetPassword) {
      return res.status(403).json({
        error: "Password reset required"
      });
    }

    recordSuccessfulLogin(u);

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      {
        id: u.id,
        role: u.role,
        companyId: u.companyId || null,
        tokenVersion: u.tokenVersion || 0
      },
      null,
      "7d"
    );

    return res.json({
      token,
      user: safeUserResponse(u)
    });

  } catch (e) {
    return res.status(403).json({
      error: e?.message || String(e)
    });
  }
});

/* =========================================================
   REFRESH
========================================================= */

router.post("/refresh", authRequired, (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    if (!dbUser) {
      return res.status(401).json({ error: "User not found" });
    }

    if (dbUser.locked) {
      return res.status(403).json({ error: "Account suspended" });
    }

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      {
        id: dbUser.id,
        role: dbUser.role,
        companyId: dbUser.companyId || null,
        tokenVersion: dbUser.tokenVersion || 0
      },
      null,
      "7d"
    );

    audit({
      actor: dbUser.id,
      role: dbUser.role,
      action: "TOKEN_REFRESHED"
    });

    return res.json({
      token,
      user: safeUserResponse(dbUser)
    });

  } catch (e) {
    return res.status(403).json({
      error: e?.message || String(e)
    });
  }
});

module.exports = router;
