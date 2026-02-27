/* =========================================================
   📅 COMPLIANCE SNAPSHOT ENGINE
   Daily Snapshot • Audit Anchored • Retention Enforced
========================================================= */

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function calculateComplianceScore(db) {
  const vulns = db.vulnerabilities || [];

  const critical = vulns.filter(v => v.severity === "critical").length;
  const high = vulns.filter(v => v.severity === "high").length;
  const medium = vulns.filter(v => v.severity === "medium").length;

  let score = 100 - (critical * 12 + high * 7 + medium * 4);
  score = Math.max(10, Math.min(100, score));

  return {
    score,
    breakdown: { critical, high, medium }
  };
}

function calculateExecutiveRiskScore(db) {
  const events = db.securityEvents || [];

  const critical = events.filter(e => e.severity === "critical").length;
  const high = events.filter(e => e.severity === "high").length;
  const medium = events.filter(e => e.severity === "medium").length;

  const score = Math.min(
    100,
    critical * 25 + high * 12 + medium * 5
  );

  return {
    score,
    breakdown: { critical, high, medium }
  };
}

function enforceSnapshotRetention(db) {
  const retentionDays =
    db.retentionPolicy?.snapshotRetentionDays || 365 * 3;

  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

  db.complianceSnapshots = (db.complianceSnapshots || [])
    .filter(s => new Date(s.createdAt).getTime() > cutoff);

  return db;
}

function runComplianceSnapshot() {
  try {
    const db = readDb();

    const compliance = calculateComplianceScore(db);
    const executiveRisk = calculateExecutiveRiskScore(db);

    const snapshot = {
      id: `snapshot_${Date.now()}`,
      createdAt: new Date().toISOString(),
      compliance,
      executiveRisk,
      securityStatus: globalSecurityStatus
    };

    db.complianceSnapshots = db.complianceSnapshots || [];
    db.complianceSnapshots.push(snapshot);

    enforceSnapshotRetention(db);

    writeDb(db);

    writeAudit({
      actor: "system",
      role: "system",
      action: "DAILY_COMPLIANCE_SNAPSHOT",
      detail: {
        complianceScore: compliance.score,
        executiveRiskScore: executiveRisk.score
      }
    });

    console.log("[SNAPSHOT] Daily compliance snapshot stored");

  } catch (err) {
    console.error("[SNAPSHOT ERROR]", err);
  }
}

setInterval(runComplianceSnapshot, SNAPSHOT_INTERVAL_MS);
