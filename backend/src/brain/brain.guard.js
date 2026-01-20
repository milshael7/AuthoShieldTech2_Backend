const { requireRole } = require('../middleware/auth');

const brainAdminOnly = [
  requireRole('admin')
];

module.exports = { brainAdminOnly };
