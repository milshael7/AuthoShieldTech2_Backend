// Real-Time Cybersecurity Event Engine
// Tenant-Isolated • Persistent • AI-readable • Production-safe

const fs = require("fs");
const path = require("path");
const { addMemory } = require("../lib/brain");

const EVENTS_PATH =
  process.env.SECURITY_EVENTS_PATH ||
  path.join("/tmp", "security_events.json");

const MAX_EVENTS = 2000;

/* ================= HELPERS ================= */

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(file) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

/* ================= STATE ================= */

let state = {
  createdAt: nowIso(),
  updatedAt: nowIso(),
  tenants: {}, // 🔐 tenant isolated
};

/* ================= LOAD / SAVE ================= */

function load() {
  try {
    ensureDir(EVENTS_PATH);
    if (!fs.existsSync(EVENTS_PATH)) return;
    state = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf-8"));
  } catch {
    state = { createdAt: nowIso(), updatedAt: nowIso(), tenants: {} };
  }
}

function save() {
  try {
    state.updatedAt = nowIso();
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(state, null, 2));
  } catch {}
}

load();

/* ================= INTERNAL ================= */

function ensureTenant(tenantId) {
  if (!tenantId) tenantId = "global";

  if (!state.tenants[tenantId]) {
    state.tenants[tenantId] = {
      events: [],
      createdAt: nowIso(),
    };
  }

  return state.tenants[tenantId];
}

/* ================= CORE ================= */

function recordEvent({
  tenantId,
  type,
  severity = "info",
  source,
  target,
  description,
  meta = {},
}) {
  const tenant = ensureTenant(tenantId);

  const evt = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    iso: nowIso(),
    type,
    severity,
    source,
    target,
    description,
    meta,
  };

  tenant.events.push(evt);

  if (tenant.events.length > MAX_EVENTS) {
    tenant.events = tenant.events.slice(-MAX_EVENTS);
  }

  save();

  addMemory({
    type: "site",
    text: `Security event: ${severity.toUpperCase()} — ${description}`,
    meta: evt,
  });

  return evt;
}

function listEvents({ tenantId, limit = 100, severity = null } = {}) {
  const tenant = ensureTenant(tenantId);

  let events = tenant.events.slice().reverse();

  if (severity) {
    events = events.filter((e) => e.severity === severity);
  }

  return events.slice(0, limit);
}

module.exports = {
  recordEvent,
  listEvents,
};
