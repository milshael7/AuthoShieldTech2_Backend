// backend/src/lib/audit.js
const { readDb, writeDb } = require('./db');
const { nanoid } = require('nanoid');

function ensureAudit(db) {
  if (!db.audit) db.audit = [];
  if (!Array.isArray(db.audit)) db.audit = [];
}

function nowISO() {
  return new Date().toISOString();
}

function safeObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return {};
}

/**
 * audit({
 *   actorId,
 *   action,
 *   targetType,
 *   targetId,
 *   companyId,
 *   metadata
 * })
 */
function audit(event = {}) {
  const db = readDb();
  ensureAudit(db);

  const e = safeObj(event);

  const rec = {
    id: nanoid(),
    at: nowISO(),

    // normalized fields (but we keep whatever else you pass too)
    actorId: e.actorId ?? null,
    action: e.action ?? 'EVENT',
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    companyId: e.companyId ?? null,
    metadata: e.metadata && typeof e.metadata === 'object' ? e.metadata : null,

    // keep any extra fields for future expansion
    ...e,
  };

  db.audit.push(rec);
  writeDb(db);
  return rec;
}

module.exports = { audit };
