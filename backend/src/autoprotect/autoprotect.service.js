// backend/src/autoprotect/autoprotect.service.js
// AutoProtect Engine — Fully Hardened • Schedule Aware • Limit Enforced

const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");
const { readDb, updateDb } = require("../lib/db");
const {
  canRunAutoProtect,
  registerAutoProtectJob,
} = require("../users/user.service");

/* =========================================================
   UTIL
========================================================= */

function now() {
  return new Date();
}

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
   SCHEDULE + VACATION CHECK
========================================================= */

function withinWorkingWindow(userAPCompany) {
  if (!userAPCompany?.schedule) return false;

  const { workingDays, startTime, endTime } =
    userAPCompany.schedule;

  const nowDate = now();

  const day = nowDate.getDay(); // 0-6
  const hour = nowDate.getHours();
  const minute = nowDate.getMinutes();

  const timeNow = hour * 60 + minute;

  const startParts = (startTime || "00:00").split(":");
  const endParts = (endTime || "23:59").split(":");

  const start = parseInt(startParts[0]) * 60 +
    parseInt(startParts[1] || 0);
  const end = parseInt(endParts[0]) * 60 +
    parseInt(endParts[1] || 0);

  const workingDayMatch =
    Array.isArray(workingDays) &&
    workingDays.includes(day);

  return workingDayMatch && timeNow >= start && timeNow <= end;
}

function withinVacation(userAPCompany) {
  if (!userAPCompany?.vacation?.from) return false;

  const nowTs = Date.now();
  const from = new Date(userAPCompany.vacation.from).getTime();
  const to = new Date(userAPCompany.vacation.to).getTime();

  return nowTs >= from && nowTs <= to;
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

  ensureCompanyMembership(actorId, companyId);

  /* --------------------------------------------------
     🔥 STATUS + LIMIT CHECK
  -------------------------------------------------- */

  if (!canRunAutoProtect(actorId)) {
    throw new Error("AutoProtect inactive or limit reached");
  }

  const db = readDb();
  const userAP = db.autoprotek?.users?.[actorId];

  if (!userAP) {
    throw new Error("AutoProtect not configured");
  }

  const companyContainer =
    userAP.companies?.[companyId];

  if (!companyContainer) {
    throw new Error("Company schedule not configured");
  }

  if (!withinWorkingWindow(companyContainer)) {
    throw new Error("Outside working schedule");
  }

  if (withinVacation(companyContainer)) {
    throw new Error("User on vacation");
  }

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
    const ap = db2.autoprotek.users[actorId];
    const companyData =
      ap.companies[companyId];

    companyData.reports = companyData.reports || [];
    companyData.emailDrafts =
      companyData.emailDrafts || [];

    companyData.reports.push(report);

    companyData.emailDrafts.push({
      id: `EMAIL-${jobId}`,
      reportId: jobId,
      createdAt: nowIso(),
      sent: false,
    });
  });

  /* --------------------------------------------------
     🔥 REGISTER JOB COUNT
  -------------------------------------------------- */

  registerAutoProtectJob(actorId);

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
     🔥 NOTIFY OWNER
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
