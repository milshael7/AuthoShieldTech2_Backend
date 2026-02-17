// backend/src/services/securityTools.js
// Enterprise Security Tool State Engine — Hardened v2
// Tenant-Isolated • Admin-Controllable • Auditable • 70+ Tool Ready

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
   Later this will expand to 70+
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
  blockedTools: [],
  companies: {
     companyId: {
        installed: [],
        createdAt
     }
  }
}
*/

let state = {
  createdAt: nowIso(),
  updatedAt: nowIso(),
  blockedTools: [],
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
      blockedTools: [],
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
    if (Object.keys(state.companies).length > MAX_COMPANIES) {
      throw new Error("Company limit exceeded");
    }

    state.companies[id] = {
      installed: [],
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
    blocked: state.blockedTools,
  };
}

/* =========================================================
   INSTALL
========================================================= */

function installTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  if (state.blockedTools.includes(tool)) {
    throw new Error("Tool is globally blocked by admin");
  }

  const installed = state.companies[id].installed;

  if (installed.length >= MAX_TOOLS_PER_COMPANY) {
    throw new Error("Tool limit exceeded");
  }

  if (!installed.includes(tool)) {
    installed.push(tool);
    save();

    audit({
      actorId,
      action: "TOOL_INSTALLED",
      targetType: "Tool",
      targetId: tool,
      companyId: id,
    });
  }

  return installed;
}

/* =========================================================
   UNINSTALL
========================================================= */

function uninstallTool(companyId, toolId, actorId = "system") {
  const id = ensureCompany(companyId);
  const tool = validateTool(toolId);

  state.companies[id].installed =
    state.companies[id].installed.filter((t) => t !== tool);

  save();

  audit({
    actorId,
    action: "TOOL_UNINSTALLED",
    targetType: "Tool",
    targetId: tool,
    companyId: id,
  });

  return state.companies[id].installed;
}

/* =========================================================
   ADMIN CONTROL — GLOBAL BLOCK
========================================================= */

function blockTool(toolId, actorId) {
  const tool = validateTool(toolId);

  if (!state.blockedTools.includes(tool)) {
    state.blockedTools.push(tool);
    save();

    audit({
      actorId,
      action: "ADMIN_BLOCK_TOOL",
      targetType: "Tool",
      targetId: tool,
    });
  }

  return state.blockedTools;
}

function unblockTool(toolId, actorId) {
  const tool = validateTool(toolId);

  state.blockedTools =
    state.blockedTools.filter((t) => t !== tool);

  save();

  audit({
    actorId,
    action: "ADMIN_UNBLOCK_TOOL",
    targetType: "Tool",
    targetId: tool,
  });

  return state.blockedTools;
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
