// backend/src/services/securityEvents.js
// Real-Time Cybersecurity Event Engine
// Persistent • AI-readable • Production-safe

const fs = require("fs");
const path = require("path");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

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
  events: [],
};

/* ================= LOAD / SAVE ================= */

function load() {
  try {
    ensureDir(EVENTS_PATH);
    if (!fs.existsSync(EVENTS_PATH)) return;
    state = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf-8"));
  } catch {
    state = { createdAt: nowIso(), updatedAt: nowIso(), events: [] };
  }
}

function save() {
  try {
    state.updatedAt = nowIso();
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(state, null, 2));
  } catch {}
}

load();

/* ================= CORE ================= */

/**
 * recordEvent
 * Used by:
 * - login monitoring
 * - email protection
 * - API abuse detection
 * - WAF / IDS hooks
 */
function recordEvent({
  type,
  severity = "info",
  source,
  target,
  description,
  meta = {},
}) {
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

  state.events.push(evt);
  save();

  // Feed AuthoDev 6.5 (NON-RESET MEMORY)
  addMemory({
    type: "site",
    text: `Security event: ${severity.toUpperCase()} — ${description}`,
    meta: evt,
  });

  return evt;
}

function listEvents({ limit = 100, severity = null } = {}) {
  let events = state.events.slice().reverse();

  if (severity) {
    events = events.filter((e) => e.severity === severity);
  }

  return events.slice(0, limit);
}

module.exports = {
  recordEvent,
  listEvents,
};
