// backend/src/routes/company.routes.js
// Company Room API (members + notifications)
//
// ✅ Company role can manage members in their own company
// ✅ Admin can view/manage any company (by passing ?companyId=... or {companyId} in body)
// ✅ Safe scoping: cannot read/mark notifications outside company scope

const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications, markRead } = require('../lib/notify');

router.use(authRequired);

// ---------------- helpers ----------------

function safeStr(v) {
  return String(v || '').trim();
}

// Resolve company scope for this request
function getCompanyId(req) {
  const role = req.user?.role;

  // Admin can inspect any company by query/body (fallback to their own if present)
  if (role === users.ROLES.ADMIN) {
    const fromQuery = safeStr(req.query.companyId);
    const fromBody = safeStr(req.body?.companyId);
    return fromQuery || fromBody || safeStr(req.user.companyId);
  }

  // Company users: only their assigned company
  return safeStr(req.user.companyId);
}

function requireCompany(req, res) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'No company assigned' });
    return null;
  }
  return companyId;
}

// ---------------- routes ----------------

// ✅ GET /api/company/me
router.get(
  '/me',
  requireRole(users.ROLES.COMPANY, users.ROLES.ADMIN),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const c = companies.getCompany(companyId);
      if (!c) return res.status(404).json({ error: 'Company not found' });

      return res.json(c);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }
);

// ✅ GET /api/company/notifications
router.get(
  '/notifications',
  requireRole(users.ROLES.COMPANY, users.ROLES.ADMIN),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      return res.json(listNotifications({ companyId }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }
);

// ✅ POST /api/company/notifications/:id/read
router.post(
  '/notifications/:id/read',
  requireRole(users.ROLES.COMPANY, users.ROLES.ADMIN),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const id = safeStr(req.params.id);
      if (!id) return res.status(400).json({ error: 'Missing notification id' });

      // ✅ scope enforced here (companyId must match)
      const n = markRead(id, null, companyId);
      if (!n) return res.status(404).json({ error: 'Not found' });

      return res.json(n);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }
);

// ✅ POST /api/company/members/add
router.post(
  '/members/add',
  requireRole(users.ROLES.COMPANY, users.ROLES.ADMIN),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const userId = safeStr(req.body?.userId);
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      return res.json(companies.addMember(companyId, userId, req.user.id));
    } catch (e) {
      return res.status(400).json({ error: e?.message || String(e) });
    }
  }
);

// ✅ POST /api/company/members/remove
router.post(
  '/members/remove',
  requireRole(users.ROLES.COMPANY, users.ROLES.ADMIN),
  (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) return;

      const userId = safeStr(req.body?.userId);
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      return res.json(companies.removeMember(companyId, userId, req.user.id));
    } catch (e) {
      return res.status(400).json({ error: e?.message || String(e) });
    }
  }
);

module.exports = router;
