// backend/src/routes/posture.routes.js
// Cybersecurity "Posture" (MVP) — summary + checks + recent events
// ✅ Admin + Manager can view everything
// ✅ Company + Individual can view only their own scope
// ✅ Normalizes notification fields (at + createdAt) so frontend never breaks

const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const { readDb } = require('../lib/db');
const users = require('../users/user.service');

router.use(authRequired);

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function nowISO() {
  return new Date().toISOString();
}

function roleOf(u) {
  return String(u?.role || '');
}

function isAdmin(u) {
  return roleOf(u) === users.ROLES.ADMIN;
}
function isManager(u) {
  return roleOf(u) === users.ROLES.MANAGER;
}
function isCompany(u) {
  return roleOf(u) === users.ROLES.COMPANY;
}

// Normalize notifications so UI can safely read either field
function normNotification(n) {
  if (!n) return n;
  const at = n.at || n.createdAt || null;
  return {
    ...n,
    at,
    createdAt: n.createdAt || at, // keep both
  };
}

// Starter “checks” list (expand later with real signals)
function buildChecks({ user }) {
  const ap = !!(user && (user.autoprotectEnabled || user.autoprotechEnabled)); // supports typo too
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
      status: ap ? 'ok' : 'warn',
      message: ap
        ? 'AutoProtect is enabled for this account.'
        : 'AutoProtect is disabled for this account.',
      at: nowISO(),
    },
  ];
}

function scopeFor(reqUser) {
  // Admin/Manager see global
  if (isAdmin(reqUser) || isManager(reqUser)) return { type: 'global' };

  // Company sees company scope
  if (isCompany(reqUser)) {
    // Prefer companyId if present; otherwise fall back to their own id
    return { type: 'company', companyId: reqUser?.companyId || reqUser?.id };
  }

  // Individual sees user scope
  return { type: 'user', userId: reqUser?.id };
}

// GET /api/posture/summary
router.get('/summary', (req, res) => {
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
router.get('/checks', (req, res) => {
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
router.get('/recent', (req, res) => {
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
        notifications: notifications.slice(0, limit).map(normNotification),
        time: nowISO(),
      });
    }

    if (scope.type === 'company') {
      const companyId = String(scope.companyId || '');
      const a = audit.filter(ev => String(ev.companyId || '') === companyId).slice(0, limit);
      const n = notifications
        .filter(x => String(x.companyId || '') === companyId)
        .slice(0, limit)
        .map(normNotification);

      return res.json({ scope, audit: a, notifications: n, time: nowISO() });
    }

    const userId = String(scope.userId || '');
    const a = audit
      .filter(ev => String(ev.actorId || '') === userId || String(ev.targetId || '') === userId)
      .slice(0, limit);

    const n = notifications
      .filter(x => String(x.userId || '') === userId)
      .slice(0, limit)
      .map(normNotification);

    return res.json({ scope, audit: a, notifications: n, time: nowISO() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
