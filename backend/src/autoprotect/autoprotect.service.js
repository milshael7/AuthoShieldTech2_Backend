// backend/src/autoprotect/autoprotect.service.js
// Project Engine — Hardened • Branch Aware • Company Safe

const { audit } = require("../lib/audit");
const { createNotification } = require("../lib/notify");
const { readDb } = require("../lib/db");

/* =========================================================
   HELPERS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function clean(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function ensureCompanyMembership(actorId, companyId) {
  if (!companyId) return true;

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
   RESPONSE PLAYBOOK
========================================================= */

function guidanceForIssue(issue) {
  const type = clean(issue?.type, 100).toLowerCase();

  const base = [
    "Confirm scope (what, who, when).",
    "Preserve evidence (logs, timestamps).",
    "Contain (isolate impacted accounts/systems).",
    "Eradicate (patch, rotate credentials, remove artifacts).",
    "Recover (restore services and monitor).",
    "Document findings and actions taken.",
  ];

  if (type === "phishing") {
    base.unshift(
      "Send internal advisory to avoid suspicious links."
    );
  }

  if (type === "malware") {
    base.unshift(
      "Disconnect impacted endpoint from the network immediately."
    );
  }

  if (type === "ransomware") {
    base.unshift(
      "Disable lateral movement and isolate affected systems."
    );
  }

  return base;
}

/* =========================================================
   PROJECT CREATION
========================================================= */

function createProject({
  actorId,
  companyId = null,
  title,
  issue,
}) {
  if (!actorId) {
    throw new Error("Actor required");
  }

  if (!clean(title, 200)) {
    throw new Error("Title required");
  }

  if (!isObject(issue)) {
    throw new Error("Invalid issue payload");
  }

  const issueType = clean(issue.type, 100);
  const details = clean(issue.details, 2000);

  if (!issueType) {
    throw new Error("Issue type required");
  }

  // 🔐 Membership enforcement
  ensureCompanyMembership(actorId, companyId);

  const project = {
    id: `PRJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: clean(title, 200),
    companyId: companyId || null,
    issue: {
      type: issueType,
      details,
    },
    createdAt: nowIso(),
    status: "Open",
    steps: guidanceForIssue({ type: issueType }),
    notes: [],
  };

  /* --------------------------------------------------
     AUDIT
  -------------------------------------------------- */

  audit({
    actorId,
    action: "PROJECT_CREATED",
    targetType: "Project",
    targetId: project.id,
    metadata: {
      companyId,
      issueType,
    },
  });

  /* --------------------------------------------------
     NOTIFY (COMPANY SCOPED)
  -------------------------------------------------- */

  if (companyId) {
    createNotification({
      companyId,
      severity: "info",
      title: "New project created",
      message: `Project "${project.title}" opened.`,
    });
  }

  return project;
}

module.exports = {
  guidanceForIssue,
  createProject,
};
