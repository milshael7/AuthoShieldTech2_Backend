// backend/src/services/autoprotect.project.js
// AutoProtect Project Engine — FINAL LOCKED VERSION
//
// ENFORCEMENTS ADDED:
// ✅ Individual only
// ✅ Must be enabled
// ✅ 10 active job limit
// ✅ Persisted in DB
// ✅ Audited + Notified
// ✅ No silent fixes

const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');
const { readDb, writeDb } = require('../lib/db');
const { ROLES } = require('../users/user.service');

const AUTOPROTECT_LIMIT = 10;

/* ================= HELPERS ================= */

function nowISO() {
  return new Date().toISOString();
}

function projectId() {
  return `AP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function guidanceForIssue(issue) {
  const base = [
    'Confirm scope (what happened, when, which account).',
    'Preserve evidence (timestamps, screenshots, logs).',
    'Contain the issue (limit access, isolate exposure).',
    'Remediate (apply fixes, rotate credentials).',
    'Verify resolution (monitor activity).',
    'Close project and document outcome.',
  ];

  if (issue?.type === 'phishing') {
    base.unshift(
      'Do NOT click the link again.',
      'Report the phishing email to your provider.'
    );
  }

  if (issue?.type === 'malware') {
    base.unshift(
      'Disconnect the affected device from the network.',
      'Run a trusted malware scan.'
    );
  }

  if (issue?.type === 'account_takeover') {
    base.unshift(
      'Immediately reset your password.',
      'Enable MFA on all supported services.'
    );
  }

  return base;
}

/* ================= MAIN CREATOR ================= */

function createProject({ actorId, title, issue }) {
  if (!actorId) {
    throw new Error('Actor required');
  }

  const db = readDb();

  if (!Array.isArray(db.autoprotectProjects)) {
    db.autoprotectProjects = [];
  }

  const user = (db.users || []).find(u => u.id === actorId);

  if (!user) {
    throw new Error('User not found');
  }

  /* ===== ROLE ENFORCEMENT ===== */

  if (user.role !== ROLES.INDIVIDUAL) {
    throw new Error('AutoProtect is available to Individual users only.');
  }

  /* ===== ENABLED ENFORCEMENT ===== */

  if (!user.autoprotectEnabled) {
    throw new Error('Enable AutoProtect before creating projects.');
  }

  /* ===== ACTIVE LIMIT ENFORCEMENT ===== */

  const activeProjects = db.autoprotectProjects.filter(
    p => p.actorId === actorId && p.status === 'Open'
  );

  if (activeProjects.length >= AUTOPROTECT_LIMIT) {
    throw new Error(
      `AutoProtect limit reached (${AUTOPROTECT_LIMIT}). Complete existing projects before creating more.`
    );
  }

  /* ===== CREATE PROJECT ===== */

  const project = {
    id: projectId(),
    actorId,
    title: String(title).trim(),
    issue: {
      type: issue?.type || 'unknown',
      description: issue?.description || 'Unspecified security issue.',
      detectedAt: nowISO(),
    },
    status: 'Open',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    steps: guidanceForIssue(issue),
    notes: [],
    completedAt: null,
  };

  db.autoprotectProjects.push(project);
  writeDb(db);

  /* ===== AUDIT ===== */

  audit({
    actorId,
    action: 'AUTOPROTECT_PROJECT_CREATED',
    targetType: 'AutoProtectProject',
    targetId: project.id,
    metadata: {
      title: project.title,
      issueType: project.issue.type,
    },
  });

  /* ===== NOTIFY USER ===== */

  createNotification({
    userId: actorId,
    severity: 'warn',
    title: 'AutoProtect Action Required',
    message: `A new security project "${project.title}" has been created. Review the steps and take action.`,
  });

  return project;
}

module.exports = {
  createProject,
};
