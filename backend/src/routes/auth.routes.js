// backend/src/routes/auth.routes.js
// Auth API — Phase 7 Approval + Multi-Tenant Hardened

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const { sign } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const users = require("../users/user.service");

/* =========================================================
   HELPERS
========================================================= */

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function safeUserResponse(u) {
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    companyId: u.companyId || null,
    subscriptionStatus: u.subscriptionStatus,
    status: u.status,
    mustResetPassword: !!u.mustResetPassword,
  };
}

function ensureJwtSecret(res) {
  if (!process.env.JWT_SECRET) {
    res.status(500).json({
      error: "Server misconfigured (JWT_SECRET missing)",
    });
    return false;
  }
  return true;
}

/* =========================================================
   SIGNUP (PENDING FLOW)
========================================================= */

router.post("/signup", (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);
    const role = cleanStr(req.body?.role || "Individual");

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required",
      });
    }

    const created = users.createUser({
      email,
      password,
      role,
    });

    return res.status(201).json({
      ok: true,
      message: "Account created. Pending approval.",
      user: safeUserResponse(created),
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e),
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
        error: "Email and password required",
      });
    }

    const u = users.findByEmail(email);

    // Anti-enumeration
    if (!u) {
      await bcrypt.compare(password, "$2a$10$invalidsaltinvalidsaltinv");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, u.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 🔒 Approval enforcement
    if (u.status !== users.APPROVAL_STATUS.APPROVED) {
      return res.status(403).json({
        error: "Account not approved",
        status: u.status,
      });
    }

    if (u.locked === true) {
      return res.status(403).json({ error: "Account suspended" });
    }

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      { id: u.id, role: u.role, companyId: u.companyId || null },
      null,
      "7d"
    );

    return res.json({
      token,
      user: safeUserResponse(u),
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   REFRESH
========================================================= */

router.post("/refresh", authRequired, (req, res) => {
  try {
    const u = users.findByEmail(req.user.email) || null;

    if (!u) {
      return res.status(401).json({ error: "User not found" });
    }

    if (u.status !== users.APPROVAL_STATUS.APPROVED) {
      return res.status(403).json({
        error: "Account not approved",
      });
    }

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      { id: u.id, role: u.role, companyId: u.companyId || null },
      null,
      "7d"
    );

    return res.json({
      token,
      user: safeUserResponse(u),
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   RESET PASSWORD
========================================================= */

router.post("/reset-password", (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const newPassword = cleanStr(req.body?.newPassword, 500);

    if (!email || !newPassword) {
      return res.status(400).json({
        error: "Email and newPassword required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters",
      });
    }

    const u = users.findByEmail(email);
    if (!u) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    users.setPassword?.(u.id, newPassword, u.id);

    return res.json({ ok: true });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
