// ==========================================================
// 🔒 AUTOSHIELD AUTH ENGINE — v7.1 (ANALYTICS SYNCED)
// FILE: backend/src/routes/auth.routes.js
// ==========================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const router = express.Router();

const { sign, verify } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
const { buildFingerprint, classifyDeviceRisk } = require("../lib/deviceFingerprint");
const users = require("../users/user.service");

// IMPORT THE ANALYTICS ENGINE WE FIXED
const { recordVisit } = require("../services/analyticsEngine");

const MAX_LOGIN_ATTEMPTS = 5;
const DEVICE_STRICT = process.env.DEVICE_BINDING_STRICT === "true";

/* ================= HELPERS ================= */

function nowIso() { return new Date().toISOString(); }
function uid(prefix = "id") { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function cleanEmail(v) { return String(v || "").trim().toLowerCase(); }
function cleanStr(v, max = 200) { return String(v || "").trim().slice(0, max); }
async function safeDelay() { return new Promise((resolve) => setTimeout(resolve, 400)); }

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/* ================= LOGIN ROUTE ================= */

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password required" });
    }

    const u = users.findByEmail(email);

    // 1. If User doesn't exist
    if (!u) {
      await safeDelay();
      // Record failed attempt in the Lively Analytics Room
      recordVisit({ type: "AUTH_FAILURE", path: "/login", source: "auth", country: "Unknown" });
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // 2. Check Password
    const valid = await bcrypt.compare(password, u.passwordHash);

    if (!valid) {
      updateDb((db) => {
        const user = db.users.find(x => x.id === u.id);
        if (!user.securityFlags) user.securityFlags = {};
        user.securityFlags.failedLogins = (user.securityFlags.failedLogins || 0) + 1;
        if (user.securityFlags.failedLogins >= MAX_LOGIN_ATTEMPTS) user.locked = true;
        return db;
      });

      // Record failure for this specific user
      recordVisit({ 
        type: "AUTH_FAILURE", 
        path: "/login", 
        source: "auth", 
        tenantId: u.id 
      });

      await safeDelay();
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // 3. Check Account Lock
    if (u.locked) {
      return res.status(403).json({ ok: false, error: "Account suspended" });
    }

    // 4. Success - Update DB and State
    const fingerprint = buildFingerprint(req);
    let newTokenVersion;

    updateDb((db) => {
      const user = db.users.find(x => x.id === u.id);
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      newTokenVersion = user.tokenVersion;
      user.activeDeviceFingerprint = fingerprint;
      user.lastLoginAt = nowIso();
      if (user.securityFlags) user.securityFlags.failedLogins = 0;
      return db;
    });

    const jti = uid("jti");

    // 5. SIGN TOKEN (Aligned with Server v32.1)
    const token = sign(
      {
        id: u.id,
        jti,
        role: u.role,
        companyId: u.companyId || null,
        tokenVersion: newTokenVersion,
      },
      "access", // Explicitly set as access type
      "15m"
    );

    // 6. RECORD SUCCESS IN LIVELY ANALYTICS
    recordVisit({ 
      type: "AUTH_SUCCESS", 
      path: "/login", 
      source: "auth", 
      tenantId: u.id,
      country: req.body?.country || "Unknown"
    });

    audit({ actor: u.id, role: u.role, action: "LOGIN_SUCCESS" });

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
    console.error("Login Error:", e);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

/* ================= REFRESH / LOGOUT ================= */

router.post("/refresh", (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

    const payload = verify(token, "access");
    if (!payload) return res.status(401).json({ ok: false, error: "Invalid session" });

    const dbUser = users.findById(payload.id);
    if (!dbUser || Number(payload.tokenVersion) !== Number(dbUser.tokenVersion)) {
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    const newJti = uid("jti");
    const newToken = sign(
      {
        id: dbUser.id,
        jti: newJti,
        role: dbUser.role,
        companyId: dbUser.companyId || null,
        tokenVersion: dbUser.tokenVersion,
      },
      "access",
      "15m"
    );

    return res.json({ ok: true, token: newToken });

  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token refresh failed" });
  }
});

router.post("/logout", authRequired, (req, res) => {
  recordVisit({ type: "LOGOUT", path: "/logout", source: "auth", tenantId: req.user.id });
  return res.json({ ok: true });
});

module.exports = router;
