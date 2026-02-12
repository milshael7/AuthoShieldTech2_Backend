// backend/src/services/securityTools.js
// Enterprise Security Tool State Engine
// Persistent • Tenant-aware ready • Upgrade-safe

const fs = require("fs");
const path = require("path");

const DATA_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const MAX_COMPANIES = 5000;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(file) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}
}

/* ================= STATE ================= */

let state = {
  createdAt: nowIso(),
  updatedAt: nowIso(),
  companies: {}, // { companyId: { installed: [] } }
};

/* ================= LOAD / SAVE ================= */

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

/* ================= CORE ================= */

function ensureCompany(companyId) {
  if (!state.companies[companyId]) {
    state.companies[companyId] = {
      installed: [],
      createdAt: nowIso(),
    };
  }
}

function listTools(companyId) {
  ensureCompany(companyId);
  return state.companies[companyId].installed;
}

function installTool(companyId, toolId) {
  ensureCompany(companyId);

  if (!state.companies[companyId].installed.includes(toolId)) {
    state.companies[companyId].installed.push(toolId);
    save();
  }

  return state.companies[companyId].installed;
}

function uninstallTool(companyId, toolId) {
  ensureCompany(companyId);

  state.companies[companyId].installed =
    state.companies[companyId].installed.filter(
      (t) => t !== toolId
    );

  save();

  return state.companies[companyId].installed;
}

module.exports = {
  listTools,
  installTool,
  uninstallTool,
};
