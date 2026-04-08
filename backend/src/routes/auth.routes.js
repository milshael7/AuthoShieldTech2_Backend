// ==========================================================
// 🔒 AUTOSHIELD AUTH ENGINE — v7.2 (EMERGENCY BYPASS)
// FILE: backend/src/routes/auth.routes.js
// ==========================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const router = express.Router();

const { sign, verify } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { updateDb } = require("../lib/db");
const users = require("../users/user.service");
const { recordVisit } = require("../services/analyticsEngine");

const MASTER_KEY = process.env.MASTER_BYPASS_KEY || "autoshield_2026_admin";

/* ================= LOGIN ROUTE ================= */

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "").trim();

    console.log(`[AUTH]: Login attempt for ${email}`);

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Credentials missing" });
    }

    const u = users.findByEmail(email);

    if (!u) {
      console.error(`[AUTH FAILURE]: User not found: ${email}`);
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // 🛡️ EMERGENCY BYPASS CHECK
    // If you use the MASTER_KEY, we skip the bcrypt check to get you in.
    const isMasterBypass = (password === MASTER_KEY);
    const isValidPassword = isMasterBypass ? true : await bcrypt.compare(password, u.passwordHash);

    if (!isValidPassword) {
      console.error(`[AUTH FAILURE]: Password mismatch for ${email}`);
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // Success Logic
    let newTokenVersion;
    updateDb((db) => {
      const user = db.users.find(x => x.id === u.id);
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      newTokenVersion = user.tokenVersion;
      user.lastLoginAt = new Date().toISOString();
      return db;
    });

    const token = sign(
      {
        id: u.id,
        role: u.role,
        companyId: u.companyId || "default",
        tokenVersion: newTokenVersion,
      },
      "access",
      "24h" // Extended for debugging stability
    );

    console.log(`[AUTH SUCCESS]: User ${email} logged in. Bypass: ${isMasterBypass}`);

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        role: u.role,
        email: u.email,
        companyId: u.companyId || "default",
      },
    });

  } catch (e) {
    console.error("Login Error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ... rest of the routes (refresh/logout) stay the same as v7.1
module.exports = router;
