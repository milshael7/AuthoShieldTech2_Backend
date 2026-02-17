// backend/src/services/securityTools.js
// Enterprise Security Tool State Engine — Hardened v3
// Tenant-Isolated • Company-Level Blocking • Admin-Governed • Auditable • 70+ Tool Ready

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
   TOOL REGISTRY (Master Catalog)
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

/* =========================================================
   STATE STRUCTURE
========================================================= */
/*
{
  createdAt,
  updatedAt,
  companies: {
     companyId: {
        installed: [],
        blocked: [],
        createdAt
     }
  }
}
*/

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
   LIST
========================================================= */

function listTools(companyId) {
  const id = ensureCompany(companyId);

  return {
    installed: state.companies[id].installed,
    blocked: state.companies[id].blocked,
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
    throw new Error("Tool is blocked by admin for this company");
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

  return {
    installed: company.installed,
    blocked: company.blocked,
  };
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

  return {
    installed: company.installed,
    blocked: company.blocked,
  };
}

/* =========================================================
   ADMIN CONTROL — COMPANY-SCOPED BLOCKING
========================================================= */

function blockTool(companyId, toolId, actorId) {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  const company = state.companies[id];

  if (!company.blocked.includes(tool)) {
    company.blocked.push(tool);

    // remove from installed if currently installed
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

  return {
    installed: company.installed,
    blocked: company.blocked,
  };
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

  return {
    installed: company.installed,
    blocked: company.blocked,
  };
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
};
