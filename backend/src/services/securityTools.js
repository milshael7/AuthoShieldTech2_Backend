// backend/src/services/securityTools.js
// Security Tool Engine — Branch Controlled • Company Scoped • Tier Safe

const fs = require("fs");
const path = require("path");
const { audit } = require("../lib/audit");

/* =========================================================
   CONFIG
========================================================= */

const DATA_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

function nowIso() {
  return new Date().toISOString();
}

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function ensureDir(file) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}
}

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
  member: [], // default
};

/* =========================================================
   STATE
========================================================= */

let state = {
  createdAt: nowIso(),
  updatedAt: nowIso(),
  companies: {},
};

/* =========================================================
   LOAD / SAVE
========================================================= */

function load() {
  try {
    ensureDir(DATA_PATH);
    if (!fs.existsSync(DATA_PATH)) return;
    state = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch {
    state = {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      companies: {},
    };
  }
}

function save() {
  try {
    state.updatedAt = nowIso();
    fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
  } catch {}
}

load();

/* =========================================================
   VALIDATION
========================================================= */

function validateTool(toolId) {
  const id = clean(toolId, 50);
  if (!TOOL_REGISTRY.has(id)) {
    throw new Error("Invalid tool id");
  }
  return id;
}

function ensureCompany(companyId) {
  const id = clean(companyId, 100);
  if (!id) throw new Error("Company id required");

  if (!state.companies[id]) {
    state.companies[id] = {
      installed: [],
      blocked: [],
      createdAt: nowIso(),
    };
  }

  return id;
}

/* =========================================================
   LIST TOOLS
========================================================= */

function listTools(companyId) {
  const id = ensureCompany(companyId);

  return {
    installed: state.companies[id].installed,
    blocked: state.companies[id].blocked,
  };
}

/* =========================================================
   INSTALL / UNINSTALL
========================================================= */

function installTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  if (!company.installed.includes(tool)) {
    company.installed.push(tool);
    save();

    audit({
      actorId,
      action: "TOOL_INSTALLED",
      targetType: "Tool",
      targetId: tool,
      companyId: id,
    });
  }

  return listTools(id);
}

function uninstallTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  company.installed = company.installed.filter((t) => t !== tool);

  save();

  audit({
    actorId,
    action: "TOOL_UNINSTALLED",
    targetType: "Tool",
    targetId: tool,
    companyId: id,
  });

  return listTools(id);
}

/* =========================================================
   BLOCKING
========================================================= */

function blockTool(companyId, toolId, actorId) {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  if (!company.blocked.includes(tool)) {
    company.blocked.push(tool);
    company.installed = company.installed.filter((t) => t !== tool);
    save();

    audit({
      actorId,
      action: "ADMIN_BLOCK_TOOL",
      targetType: "Tool",
      targetId: tool,
      companyId: id,
    });
  }

  return listTools(id);
}

function unblockTool(companyId, toolId, actorId) {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];
  company.blocked = company.blocked.filter((t) => t !== tool);

  save();

  audit({
    actorId,
    action: "ADMIN_UNBLOCK_TOOL",
    targetType: "Tool",
    targetId: tool,
    companyId: id,
  });

  return listTools(id);
}

/* =========================================================
   BRANCH FILTERING (NEW)
========================================================= */

function getVisibleToolsForBranch(companyId, branch) {
  const id = ensureCompany(companyId);

  const installed = state.companies[id].installed || [];
  const blocked = state.companies[id].blocked || [];

  const branchKey = clean(branch || "member").toLowerCase();
  const allowedForBranch =
    BRANCH_TOOLS[branchKey] || BRANCH_TOOLS.member;

  return installed
    .filter((tool) => !blocked.includes(tool))
    .filter((tool) => allowedForBranch.includes(tool));
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  listTools,
  installTool,
  uninstallTool,
  blockTool,
  unblockTool,
  getVisibleToolsForBranch,
};
