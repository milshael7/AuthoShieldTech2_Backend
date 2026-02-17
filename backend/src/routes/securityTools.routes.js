// backend/src/services/securityTools.js
// Enterprise Security Tool State Engine
// Tenant-isolated • Persistent • Admin-block capable • Scalable to 70+ tools

const fs = require("fs");
const path = require("path");

/* =========================================================
   CONFIG
========================================================= */

const DATA_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const MAX_TENANTS = 5000;

/* =========================================================
   UTIL
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
   STATE
========================================================= */

let state = {
  createdAt: nowIso(),
  updatedAt: nowIso(),
  tenants: {
    /*
      tenantId: {
        installed: [],
        blocked: [],
        createdAt,
        updatedAt
      }
    */
  },
};

/* =========================================================
   LOAD / SAVE
========================================================= */

function load() {
  try {
    ensureDir(DATA_PATH);
    if (!fs.existsSync(DATA_PATH)) return;

    state = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));

    if (!state.tenants) state.tenants = {};
  } catch {
    state = {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      tenants: {},
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
   TENANT RESOLUTION
========================================================= */

function ensureTenant(tenantId) {
  tenantId = clean(tenantId || "global", 100);

  if (!state.tenants[tenantId]) {
    if (Object.keys(state.tenants).length > MAX_TENANTS) {
      throw new Error("Tenant limit reached");
    }

    state.tenants[tenantId] = {
      installed: [],
      blocked: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  return state.tenants[tenantId];
}

/* =========================================================
   CORE API
========================================================= */

function listTools(tenantId) {
  const tenant = ensureTenant(tenantId);

  return {
    installed: tenant.installed.slice(),
    blocked: tenant.blocked.slice(),
  };
}

function installTool(tenantId, toolId) {
  const tenant = ensureTenant(tenantId);
  toolId = clean(toolId, 100);

  if (!toolId) throw new Error("Invalid toolId");

  if (tenant.blocked.includes(toolId)) {
    throw new Error("Tool is blocked by administrator");
  }

  if (!tenant.installed.includes(toolId)) {
    tenant.installed.push(toolId);
    tenant.updatedAt = nowIso();
    save();
  }

  return tenant.installed.slice();
}

function uninstallTool(tenantId, toolId) {
  const tenant = ensureTenant(tenantId);
  toolId = clean(toolId, 100);

  tenant.installed = tenant.installed.filter((t) => t !== toolId);
  tenant.updatedAt = nowIso();

  save();

  return tenant.installed.slice();
}

/* =========================================================
   ADMIN CONTROL (BLOCK / UNBLOCK)
========================================================= */

function blockTool(tenantId, toolId) {
  const tenant = ensureTenant(tenantId);
  toolId = clean(toolId, 100);

  if (!tenant.blocked.includes(toolId)) {
    tenant.blocked.push(toolId);
  }

  // force uninstall if blocked
  tenant.installed = tenant.installed.filter((t) => t !== toolId);

  tenant.updatedAt = nowIso();
  save();

  return {
    blocked: tenant.blocked.slice(),
    installed: tenant.installed.slice(),
  };
}

function unblockTool(tenantId, toolId) {
  const tenant = ensureTenant(tenantId);
  toolId = clean(toolId, 100);

  tenant.blocked = tenant.blocked.filter((t) => t !== toolId);
  tenant.updatedAt = nowIso();
  save();

  return tenant.blocked.slice();
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
