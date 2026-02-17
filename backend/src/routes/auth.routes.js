// backend/src/routes/auth.routes.js
// Auth API — Phase 5 Hardened (Production Safe)

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { sign } = require('../lib/jwt');
const { authRequired } = require('../middleware/auth');
const users = require('../users/user.service');
const { audit } = require('../lib/audit');

/* =========================================================
   HELPERS
========================================================= */

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

function safeUserResponse(u) {
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    companyId: u.companyId || null,
    mustResetPassword: !!u.mustResetPassword,
    subscriptionStatus: u.subscriptionStatus,
    autoprotectEnabled: !!(u.autoprotectEnabled || u.autoprotechEnabled),
  };
}

function ensureJwtSecret(res) {
  if (!process.env.JWT_SECRET) {
    res.status(500).json({
      error: 'Server misconfigured (JWT_SECRET missing)',
    });
    return false;
  }
  return true;
}

/* =========================================================
   LOGIN
========================================================= */

router.post('/login', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password required',
      });
    }

    const u = users.findByEmail(email);

    // Prevent user enumeration timing attacks
    if (!u) {
      await bcrypt.compare(password, '$2a$10$invalidsaltinvalidsaltinv'); 
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!u.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, u.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 🔒 Hard lock checks
    if (u.locked === true) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    if (u.subscriptionStatus === users.SUBSCRIPTION?.LOCKED) {
      return res.status(403).json({ error: 'Account locked' });
    }

    if (u.mustResetPassword) {
      return res.status(403).json({
        error: 'Password reset required',
        mustResetPassword: true,
      });
    }

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      { id: u.id, role: u.role, companyId: u.companyId || null },
      null,
      '7d'
    );

    audit({
      actorId: u.id,
      action: 'LOGIN',
      targetType: 'Session',
      targetId: u.id,
    });

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
   REFRESH TOKEN
========================================================= */

router.post('/refresh', authRequired, (req, res) => {
  try {
    const u = users.findById?.(req.user.id);

    if (!u) {
      return res.status(401).json({
        error: 'User not found',
      });
    }

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      { id: u.id, role: u.role, companyId: u.companyId || null },
      null,
      '7d'
    );

    audit({
      actorId: u.id,
      action: 'TOKEN_REFRESH',
      targetType: 'Session',
      targetId: u.id,
    });

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

router.post('/reset-password', (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const newPassword = cleanStr(req.body?.newPassword, 500);

    if (!email || !newPassword) {
      return res.status(400).json({
        error: 'Email and newPassword required',
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters',
      });
    }

    const u = users.findByEmail(email);
    if (!u) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    if (!u.mustResetPassword) {
      return res.status(400).json({
        error: 'Reset not required',
      });
    }

    users.setPassword(u.id, newPassword, u.id);

    audit({
      actorId: u.id,
      action: 'PASSWORD_RESET',
      targetType: 'User',
      targetId: u.id,
    });

    return res.json({ ok: true });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
