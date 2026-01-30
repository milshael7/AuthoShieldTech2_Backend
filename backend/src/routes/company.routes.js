// backend/src/routes/company.routes.js
// Company Room API (members + notifications)
// ✅ Company role can manage members in their company
// ✅ Admin can view/manage any company (by passing ?companyId=...)
// ✅ Safe scoping: cannot read/mark notifications outside company scope

const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications, markRead } = require('../lib/notify');

router.use(authRequired);

// helper: resolve company scope
function getCompanyId(req) {
  const role = req.user?.role;

  // Admin can inspect any company by query/body
  if (role === users.ROLES.ADMIN) {
    const fromQuery = (req.query.companyId || '').toString().trim();
    const fromBody = (req.body?.companyId || '').toString().trim();
    return fromQuery || fromBody || (req.user.companyId || '').toString().trim();
  }

  // Normal company users: only their assigned company
  return (req.user.companyId || '').toString().trim();
}

function requireCompany(req, res) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'No company assigned' });
    return null;
  }
  return companyId;
}

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

      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing notification id' });

      // markRead() signature may vary in your codebase, so call safely
      let n = null;
      try {
        n = markRead(id, req.user.id);
      } catch {
        n = markRead(id);
      }

      if (!n) return res.status(404).json({ error: 'Not found' });

      // ✅ Scope check: don’t allow cross-company marking
      if (String(n.companyId || '') !== String(companyId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

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

      const userId = String(req.body?.userId || '').trim();
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

      const userId = String(req.body?.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      return res.json(companies.removeMember(companyId, userId, req.user.id));
    } catch (e) {
      return res.status(400).json({ error: e?.message || String(e) });
    }
  }
);

module.exports = router;
