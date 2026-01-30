// backend/src/lib/notify.js
const { readDb, writeDb } = require('./db');
const { nanoid } = require('nanoid');

function ensureArray(db) {
  if (!db.notifications) db.notifications = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
}

function createNotification({ userId = null, companyId = null, severity = 'info', title, message }) {
  const db = readDb();
  ensureArray(db);

  const n = {
    id: nanoid(),
    at: new Date().toISOString(),
    userId,
    companyId,
    severity,
    title,
    message,
    read: false
  };

  db.notifications.push(n);
  writeDb(db);
  return n;
}

function listNotifications({ userId, companyId } = {}) {
  const db = readDb();
  ensureArray(db);

  return db.notifications
    .filter((n) => {
      if (userId && String(n.userId || '') !== String(userId)) return false;
      if (companyId && String(n.companyId || '') !== String(companyId)) return false;
      return true;
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * markRead(id, userId?, companyId?)
 * - Backward compatible: if you call markRead(id) it will still work.
 * - If userId/companyId provided, it will ONLY mark if it matches scope.
 */
function markRead(id, userId = null, companyId = null) {
  const db = readDb();
  ensureArray(db);

  const n = db.notifications.find((x) => String(x.id) === String(id));
  if (!n) return null;

  // If scope is provided, enforce it
  if (userId && String(n.userId || '') !== String(userId)) return null;
  if (companyId && String(n.companyId || '') !== String(companyId)) return null;

  n.read = true;
  writeDb(db);
  return n;
}

// Optional helper (nice for later UI buttons)
function markReadAll({ userId = null, companyId = null } = {}) {
  const db = readDb();
  ensureArray(db);

  let changed = 0;
  for (const n of db.notifications) {
    if (userId && String(n.userId || '') !== String(userId)) continue;
    if (companyId && String(n.companyId || '') !== String(companyId)) continue;
    if (!n.read) {
      n.read = true;
      changed++;
    }
  }

  if (changed) writeDb(db);
  return { ok: true, changed };
}

module.exports = { createNotification, listNotifications, markRead, markReadAll };
