// backend/src/routes/posture.routes.js
// Cybersecurity "Posture" (MVP) — summary + checks + recent events
// ✅ Admin + Manager can view everything
// ✅ Company + Individual can view only their own scope

const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const { readDb } = require('../lib/db');
const users = require('../users/user.service');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function nowISO() {
  return new Date().toISOString();
}

// Starter “checks” list (expand later with real signals)
function buildChecks({ user }) {
  return [
    {
      id: 'mfa',
      title: 'MFA Recommended',
      status: 'warn',
      message: 'Enable MFA for better account protection (MVP: informational).',
      at: nowISO(),
    },
    {
      id: 'password',
      title: 'Password Hygiene',
      status: 'ok',
      message: 'Password policy enforced by platform (MVP).',
      at: nowISO(),
    },
    {
      id: 'autoprotect',
      title: 'AutoProtect Status',
      status: user?.autoprotectEnabled ? 'ok' : 'warn',
      message: user?.autoprotectEnabled
        ? 'AutoProtect is enabled for this account.'
        : 'AutoProtect is disabled for this account.',
      at: nowISO(),
    },
  ];
}

function scopeFor(reqUser) {
  const role = reqUser?.role;
  if (role === users.ROLES.ADMIN || role === users.ROLES.MANAGER) {
    return { type: 'global' };
  }
  if (role === users.ROLES.COMPANY) {
    // companyId should be on the user record (preferred)
    return { type: 'company', companyId: reqUser?.companyId || reqUser?.id };
  }
  return { type: 'user', userId: reqUser?.id };
}

// GET /api/posture/summary
router.get('/summary', authRequired, (req, res) => {
  try {
    const db = readDb();
    const scope = scopeFor(req.user);

    const audit = db.audit || [];
    const notifications = db.notifications || [];
    const allUsers = db.users || [];
    const allCompanies = db.companies || [];

    if (scope.type === 'global') {
      return res.json({
        scope,
        totals: {
          users: allUsers.length,
          companies: allCompanies.length,
          auditEvents: audit.length,
          notifications: notifications.length,
        },
        time: nowISO(),
      });
    }

    if (scope.type === 'company') {
      const companyId = String(scope.companyId || '');
      const companyUsers = allUsers.filter(u => String(u.companyId || '') === companyId);
      const companyAudit = audit.filter(ev => String(ev.companyId || '') === companyId);
      const companyNotes = notifications.filter(n => String(n.companyId || '') === companyId);

      return res.json({
        scope,
        totals: {
          users: companyUsers.length,
          auditEvents: companyAudit.length,
          notifications: companyNotes.length,
        },
        time: nowISO(),
      });
    }

    const userId = String(scope.userId || '');
    const myAudit = audit.filter(ev =>
      String(ev.actorId || '') === userId || String(ev.targetId || '') === userId
    );
    const myNotes = notifications.filter(n => String(n.userId || '') === userId);

    return res.json({
      scope,
      totals: {
        auditEvents: myAudit.length,
        notifications: myNotes.length,
      },
      time: nowISO(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/checks
router.get('/checks', authRequired, (req, res) => {
  try {
    return res.json({
      scope: scopeFor(req.user),
      checks: buildChecks({ user: req.user }),
      time: nowISO(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/recent?limit=50 (max 200)
router.get('/recent', authRequired, (req, res) => {
  try {
    const db = readDb();
    const scope = scopeFor(req.user);
    const limit = clampInt(req.query.limit, 1, 200, 50);

    const audit = (db.audit || []).slice().reverse();
    const notifications = (db.notifications || []).slice().reverse();

    if (scope.type === 'global') {
      return res.json({
        scope,
        audit: audit.slice(0, limit),
        notifications: notifications.slice(0, limit),
        time: nowISO(),
      });
    }

    if (scope.type === 'company') {
      const companyId = String(scope.companyId || '');
      const a = audit.filter(ev => String(ev.companyId || '') === companyId).slice(0, limit);
      const n = notifications.filter(x => String(x.companyId || '') === companyId).slice(0, limit);
      return res.json({ scope, audit: a, notifications: n, time: nowISO() });
    }

    const userId = String(scope.userId || '');
    const a = audit
      .filter(ev => String(ev.actorId || '') === userId || String(ev.targetId || '') === userId)
      .slice(0, limit);

    const n = notifications
      .filter(x => String(x.userId || '') === userId)
      .slice(0, limit);

    return res.json({ scope, audit: a, notifications: n, time: nowISO() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
