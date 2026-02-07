// backend/src/lib/brain.js
// AutoShield AI — Persistent Memory + Personality Core
// Backward compatible with existing ai.routes.js
// Exposes:
// - addMemory({ type, text, meta })
// - listMemory({ limit, type })
// - buildPersonality()

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const MEMORY_PATH =
  (process.env.AI_MEMORY_PATH && String(process.env.AI_MEMORY_PATH).trim()) ||
  "/tmp/autoshield_brain.json";

// Hard caps per memory type (prevents bloat + hallucination)
const MAX_PER_TYPE = {
  site: 50,
  rule: 50,
  preference: 100,
  note: 200,
  trade: 300,
};

// Absolute safety cap
const MAX_TOTAL = Number(process.env.AI_MEMORY_MAX_ITEMS || 600);

/* ================= HELPERS ================= */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

/* ================= STATE ================= */

let state = {
  version: 2,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  items: [],
};

/* ================= LOAD / SAVE ================= */

function load() {
  try {
    ensureDirFor(MEMORY_PATH);
    if (!fs.existsSync(MEMORY_PATH)) return;

    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
    if (raw && Array.isArray(raw.items)) {
      state = {
        version: raw.version || 2,
        createdAt: raw.createdAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        items: raw.items.slice(-MAX_TOTAL),
      };
    }
  } catch {
    // Never crash backend due to memory corruption
    state = {
      version: 2,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
    };
  }
}

function save() {
  try {
    ensureDirFor(MEMORY_PATH);
    state.updatedAt = nowIso();

    // Global safety cap
    if (state.items.length > MAX_TOTAL) {
      state.items = state.items.slice(-MAX_TOTAL);
    }

    const tmp = MEMORY_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, MEMORY_PATH);
  } catch {}
}

load();

/* ================= CORE API ================= */

/**
 * addMemory
 * Safe, bounded, typed memory insert
 */
function addMemory({ type = "note", text = "", meta = {} } = {}) {
  const t = safeStr(type, 40).toLowerCase() || "note";
  const txt = safeStr(text, 8000);
  if (!txt) return null;

  const rec = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: t,
    text: txt,
    meta: meta && typeof meta === "object" ? meta : {},
    iso: nowIso(),
  };

  state.items.unshift(rec);

  // Enforce per-type caps
  const cap = MAX_PER_TYPE[t] || 100;
  const sameType = state.items.filter((m) => m.type === t);
  if (sameType.length > cap) {
    const removeIds = sameType.slice(cap).map((m) => m.id);
    state.items = state.items.filter((m) => !removeIds.includes(m.id));
  }

  save();
  return rec;
}

/**
 * listMemory
 * Backward compatible
 */
function listMemory({ limit = 50, type = null } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const t = type ? safeStr(type, 40).toLowerCase() : null;

  let items = state.items;
  if (t) items = items.filter((x) => x.type === t);

  return items.slice(0, n);
}

/**
 * buildPersonality
 * Used by AI routes / OpenAI system prompt
 */
function buildPersonality() {
  const rules = listMemory({ type: "rule", limit: 20 }).map((m) => m.text);
  const prefs = listMemory({ type: "preference", limit: 20 }).map((m) => m.text);
  const site = listMemory({ type: "site", limit: 20 }).map((m) => m.text);

  return {
    identity: "AutoShield",
    tone: "calm, confident, human, non-robotic",
    rules,
    preferences: prefs,
    platformFacts: site,
  };
}

/* ================= EXPORT ================= */

module.exports = {
  addMemory,
  listMemory,
  buildPersonality,
};
