// backend/src/services/securityTools.js
// Security Tool Engine — DB Integrated • Tenant Safe • Enterprise Hardened

const { readDb, writeDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const companies = require("../companies/company.service");

/* =========================================================
   MASTER TOOL REGISTRY
========================================================= */

const TOOL_REGISTRY = new Set([
  "edr",
  "itdr",
  "email",
  "data",
  "sat",
  "darkweb",
  "siem",
  "xdr",
  "forensics",
  "vulnscan",
]);

/* =========================================================
   BRANCH TOOL MAP
========================================================= */

const BRANCH_TOOLS = {
  soc: ["siem", "xdr", "edr"],
  analyst: ["vulnscan", "forensics", "data"],
  consultant: ["sat", "darkweb", "email"],
  member: [],
};

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

/* =========================================================
   INTERNAL STATE ACCESS (DB BACKED)
========================================================= */

function ensureCompanyState(db, companyId) {
  const id = clean(companyId, 100);
  if (!id) throw new Error("Company id required");

  const company = companies.getCompany(id);
  if (!company) {
    throw new Error("Company not found");
  }

  if (!db.securityTools) db.securityTools = {};
  if (!db.securityTools[id]) {
    db.securityTools[id] = {
      installed: [],
      blocked: [],
      createdAt: new Date().toISOString(),
    };
  }

  return id;
}

function validateTool(toolId) {
  const id = clean(toolId, 50);
  if (!TOOL_REGISTRY.has(id)) {
    throw new Error("Invalid tool id");
  }
  return id;
}

/* =========================================================
   LIST
========================================================= */

function listTools(companyId) {
  const db = readDb();
  const id = ensureCompanyState(db, companyId);

  return db.securityTools[id];
}

/* =========================================================
   INSTALL
========================================================= */

function installTool(companyId, toolId, actorId) {
  const db = readDb();
  const id = ensureCompanyState(db, companyId);
  const tool = validateTool(toolId);

  const companyState = db.securityTools[id];

  if (companyState.blocked.includes(tool)) {
    throw new Error("Tool is blocked for this company");
  }

  if (!companyState.installed.includes(tool)) {
    companyState.installed.push(tool);
    writeDb(db);

    audit({
      actorId,
      action: "TOOL_INSTALLED",
      targetType: "Tool",
      targetId: tool,
      companyId: id,
    });
  }

  return companyState;
}

/* =========================================================
   UNINSTALL
========================================================= */

function uninstallTool(companyId, toolId, actorId) {
  const db = readDb();
  const id = ensureCompanyState(db, companyId);
  const tool = validateTool(toolId);

  const companyState = db.securityTools[id];

  companyState.installed =
    companyState.installed.filter((t) => t !== tool);

  writeDb(db);

  audit({
    actorId,
    action: "TOOL_UNINSTALLED",
    targetType: "Tool",
    targetId: tool,
    companyId: id,
  });

  return companyState;
}

/* =========================================================
   BLOCK
========================================================= */

function blockTool(companyId, toolId, actorId) {
  const db = readDb();
  const id = ensureCompanyState(db, companyId);
  const tool = validateTool(toolId);

  const companyState = db.securityTools[id];

  if (!companyState.blocked.includes(tool)) {
    companyState.blocked.push(tool);
    companyState.installed =
      companyState.installed.filter((t) => t !== tool);

    writeDb(db);

    audit({
      actorId,
      action: "ADMIN_BLOCK_TOOL",
      targetType: "Tool",
      targetId: tool,
      companyId: id,
    });
  }

  return companyState;
}

function unblockTool(companyId, toolId, actorId) {
  const db = readDb();
  const id = ensureCompanyState(db, companyId);
  const tool = validateTool(toolId);

  const companyState = db.securityTools[id];

  companyState.blocked =
    companyState.blocked.filter((t) => t !== tool);

  writeDb(db);

  audit({
    actorId,
    action: "ADMIN_UNBLOCK_TOOL",
    targetType: "Tool",
    targetId: tool,
    companyId: id,
  });

  return companyState;
}

module.exports = {
  listTools,
  installTool,
  uninstallTool,
  blockTool,
  unblockTool,
};
