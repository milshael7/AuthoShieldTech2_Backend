// backend/src/jobs/integrity.monitor.js
// Enterprise Integrity Monitor — Phase 37
// Continuous Self-Validation • Drift Detection • Auto Audit Escalation

const { readDb, updateDb } = require("../lib/db");
const { verifyAuditIntegrity, audit } = require("../lib/audit");

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function now() {
  return Date.now();
}

/* =========================================================
   REVENUE DRIFT CHECK
========================================================= */

function checkRevenueIntegrity(db) {
  const users = db.users || [];
  const revenueSummary = db.revenueSummary || {};

  const activeUsers = users.filter(u =>
    String(u.subscriptionStatus || "").toLowerCase() === "active"
  ).length;

  const expectedMRR = activeUsers * Number(revenueSummary.planPrice || 0);
  const recordedMRR = Number(revenueSummary.MRR || 0);

  const drift = Math.abs(expectedMRR - recordedMRR);

  if (drift > 0) {
    audit({
      actor: "integrity.monitor",
      role: "system",
      action: "REVENUE_DRIFT_DETECTED",
      metadata: {
        expectedMRR,
        recordedMRR,
        drift
      }
    });
  }
}

/* =========================================================
   TENANT ISOLATION SCAN
========================================================= */

function checkTenantIsolation(db) {
  const users = db.users || [];
  const companies = db.companies || [];

  const companyIds = new Set(companies.map(c => c.id));

  users.forEach(u => {
    if (u.companyId && !companyIds.has(u.companyId)) {
      audit({
        actor: "integrity.monitor",
        role: "system",
        action: "ORPHANED_USER_COMPANY_REFERENCE",
        metadata: {
          userId: u.id,
          companyId: u.companyId
        }
      });
    }
  });
}

/* =========================================================
   TOOL ENTITLEMENT CONSISTENCY
========================================================= */

function checkToolConsistency(db) {
  const users = db.users || [];
  const tools = db.tools || [];

  const disabledTools = tools.filter(t => t.enabled === false);

  if (disabledTools.length === 0) return;

  users.forEach(u => {
    if (!u.toolEntitlements) return;

    disabledTools.forEach(t => {
      if (u.toolEntitlements.includes(t.id)) {
        audit({
          actor: "integrity.monitor",
          role: "system",
          action: "DISABLED_TOOL_ENTITLEMENT_FOUND",
          metadata: {
            userId: u.id,
            toolId: t.id
          }
        });
      }
    });
  });
}

/* =========================================================
   SUSPICIOUS LOCK PATTERN CHECK
========================================================= */

function checkLockAbuse(db) {
  const users = db.users || [];

  const recentlyLocked = users.filter(u => {
    if (!u.locked) return false;
    const updated = new Date(u.updatedAt || 0).getTime();
    return now() - updated < 5 * 60 * 1000; // last 5 min
  });

  if (recentlyLocked.length > 3) {
    audit({
      actor: "integrity.monitor",
      role: "system",
      action: "MULTIPLE_ACCOUNT_LOCKS_DETECTED",
      metadata: {
        count: recentlyLocked.length
      }
    });
  }
}

/* =========================================================
   MAIN RUNNER
========================================================= */

function runIntegrityScan() {
  try {
    const db = readDb();

    /* 1. Audit Chain Verification */
    const auditCheck = verifyAuditIntegrity();
    if (!auditCheck.ok) {
      audit({
        actor: "integrity.monitor",
        role: "system",
        action: "AUDIT_CHAIN_COMPROMISED",
        metadata: auditCheck
      });
    }

    /* 2. Revenue Integrity */
    checkRevenueIntegrity(db);

    /* 3. Tenant Isolation */
    checkTenantIsolation(db);

    /* 4. Tool Entitlements */
    checkToolConsistency(db);

    /* 5. Lock Pattern */
    checkLockAbuse(db);

  } catch (err) {
    audit({
      actor: "integrity.monitor",
      role: "system",
      action: "INTEGRITY_MONITOR_FAILURE",
      metadata: { error: err.message }
    });
  }
}

/* =========================================================
   AUTO START
========================================================= */

function startIntegrityMonitor() {
  setInterval(runIntegrityScan, CHECK_INTERVAL_MS);
  console.log("[IntegrityMonitor] Active");
}

module.exports = {
  startIntegrityMonitor,
  runIntegrityScan
};
