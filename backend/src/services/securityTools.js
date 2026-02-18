// backend/src/services/securityTools.js
// Enterprise Security Tool Engine — Branch Aware • Tier Ready • Auditable

const fs = require("fs");
const path = require("path");
const { audit } = require("../lib/audit");

/* =========================================================
   CONFIG
========================================================= */

const DATA_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const MAX_COMPANIES = 10000;
const MAX_TOOLS_PER_COMPANY = 200;

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
]);

/* =========================================================
   BRANCH TOOL PROFILES
========================================================= */

const BRANCH_TOOL_ACCESS = {
  soc: ["edr", "itdr", "darkweb"],
  analyst: ["data", "email", "darkweb"],
  consultant: ["sat", "email"],
  admin: Array.from(TOOL_REGISTRY),
  member: [],
};

/* =========================================================
   HELPERS
========================================================= */

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

function normalizePosition(pos) {
  const p = clean(pos, 50).toLowerCase();
  return BRANCH_TOOL_ACCESS[p] ? p : "member";
}

/* =========================================================
   STATE STRUCTURE
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
    if (Object.keys(state.companies).length >= MAX_COMPANIES) {
      throw new Error("Company limit exceeded");
    }

    state.companies[id] = {
      installed: [],
      blocked: [],
      createdAt: nowIso(),
    };
  }

  return id;
}

/* =========================================================
   LIST (Company-Level)
========================================================= */

function listTools(companyId) {
  const id = ensureCompany(companyId);

  return {
    installed: state.companies[id].installed,
    blocked: state.companies[id].blocked,
  };
}

/* =========================================================
   USER-SCOPED TOOL VIEW (NEW)
========================================================= */

function getToolsForUser(companyId, position) {
  const id = ensureCompany(companyId);
  const normalized = normalizePosition(position);

  const company = state.companies[id];
  const allowedForBranch = BRANCH_TOOL_ACCESS[normalized] || [];

  const visible = company.installed.filter(
    (tool) =>
      allowedForBranch.includes(tool) &&
      !company.blocked.includes(tool)
  );

  return {
    position: normalized,
    tools: visible,
  };
}

/* =========================================================
   INSTALL
========================================================= */

function installTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  if (company.blocked.includes(tool)) {
    throw new Error("Tool is blocked");
  }

  if (company.installed.length >= MAX_TOOLS_PER_COMPANY) {
    throw new Error("Tool limit exceeded");
  }

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

/* =========================================================
   UNINSTALL
========================================================= */

function uninstallTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  company.installed =
    company.installed.filter((t) => t !== tool);

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
   ADMIN BLOCKING
========================================================= */

function blockTool(companyId, toolId, actorId) {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  if (!company.blocked.includes(tool)) {
    company.blocked.push(tool);
    company.installed =
      company.installed.filter((t) => t !== tool);

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

  company.blocked =
    company.blocked.filter((t) => t !== tool);

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
   EXPORT
========================================================= */

module.exports = {
  listTools,
  getToolsForUser,
  installTool,
  uninstallTool,
  blockTool,
  unblockTool,
};
