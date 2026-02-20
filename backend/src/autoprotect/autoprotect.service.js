// backend/src/autoprotect/autoprotect.service.js
// AutoProtect Engine — Active Job Model • Subscription Safe • Hardened

const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");
const { readDb, updateDb } = require("../lib/db");
const {
  canRunAutoProtect,
  registerAutoProtectJob,
  closeAutoProtectJob,
  ROLES,
} = require("../users/user.service");

/* ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function clean(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/* =========================================================
   MEMBERSHIP ENFORCEMENT
========================================================= */

function ensureCompanyMembership(actorId, companyId) {
  const db = readDb();

  const company = (db.companies || []).find(
    (c) => c.id === companyId
  );

  if (!company || company.status !== "Active") {
    throw new Error("Company not active");
  }

  const member = (company.members || []).find(
    (m) => String(m.userId || m) === String(actorId)
  );

  if (!member) {
    throw new Error("User not assigned to company");
  }

  return true;
}

/* =========================================================
   RUN AUTOPROTECT JOB
========================================================= */

function runAutoProtectJob({
  actorId,
  companyId,
  title,
  issue,
}) {
  if (!actorId || !companyId) {
    throw new Error("Actor and company required");
  }

  if (!isObject(issue)) {
    throw new Error("Invalid issue payload");
  }

  const db = readDb();
  const user = db.users.find(u => u.id === actorId);

  if (!user) {
    throw new Error("User not found");
  }

  ensureCompanyMembership(actorId, companyId);

  /* --------------------------------------------------
     🔥 LIMIT CHECK (Active Job Model)
  -------------------------------------------------- */

  if (!canRunAutoProtect(user)) {
    throw new Error("AutoProtect inactive or active job limit reached (10)");
  }

  /* --------------------------------------------------
     🔥 REGISTER ACTIVE JOB
  -------------------------------------------------- */

  registerAutoProtectJob(user);

  /* --------------------------------------------------
     🔥 JOB CREATION
  -------------------------------------------------- */

  const jobId = `AP-${Date.now()}-${Math.floor(
    Math.random() * 1000
  )}`;

  const report = {
    id: jobId,
    title: clean(title, 200),
    issueType: clean(issue.type, 100),
    details: clean(issue.details, 2000),
    createdAt: nowIso(),
    completedAt: nowIso(),
    status: "Completed",
  };

  updateDb((db2) => {
    db2.autoprotek = db2.autoprotek || { users: {} };
    const apUser = db2.autoprotek.users[actorId];

    if (!apUser) return;

    apUser.reports = apUser.reports || [];
    apUser.reports.push(report);
  });

  /* --------------------------------------------------
     🔥 CLOSE ACTIVE JOB (Instant Completion Model)
  -------------------------------------------------- */

  if (user.role !== ROLES.ADMIN && user.role !== ROLES.MANAGER) {
    closeAutoProtectJob(user);
  }

  /* --------------------------------------------------
     🔥 AUDIT
  -------------------------------------------------- */

  audit({
    actorId,
    action: "AUTOPROTECT_JOB_EXECUTED",
    targetType: "Company",
    targetId: companyId,
    metadata: {
      jobId,
      timestamp: nowIso(),
    },
  });

  /* --------------------------------------------------
     🔥 NOTIFY
  -------------------------------------------------- */

  createNotification({
    companyId,
    severity: "info",
    title: "AutoProtect completed job",
    message: `Job ${jobId} completed at ${nowIso()}`,
  });

  return report;
}

module.exports = {
  runAutoProtectJob,
};
