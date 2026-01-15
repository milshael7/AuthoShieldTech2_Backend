const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { sign } = require('../auth/jwt');
const users = require('../users/user.service');
const { audit } = require('../lib/audit');

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = users.findByEmail(email || '');
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password || '', u.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (u.subscriptionStatus === users.SUBSCRIPTION.LOCKED) {
    return res.status(403).json({ error: 'Account locked' });
  }

  const token = sign(
    { id: u.id, role: u.role, companyId: u.companyId || null },
    process.env.JWT_SECRET,
    '7d'
  );

  audit({ actorId: u.id, action: 'LOGIN', targetType: 'Session', targetId: u.id });

  res.json({
    token,
    user: {
      id: u.id,
      role: u.role,
      email: u.email,
      companyId: u.companyId || null,
      mustResetPassword: !!u.mustResetPassword,
      subscriptionStatus: u.subscriptionStatus,
      autoprotectEnabled: !!u.autoprotechEnabled, // keep frontend-friendly name
    },
  });
});

router.post('/reset-password', (req, res) => {
  const { email, newPassword } = req.body || {};
  const u = users.findByEmail(email || '');
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (!u.mustResetPassword) return res.status(400).json({ error: 'Reset not required' });
  users.setPassword(u.id, newPassword, u.id);
  res.json({ ok: true });
});

module.exports = router;
