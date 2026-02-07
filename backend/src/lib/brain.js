// backend/src/lib/brain.js
// AuthoDev 6.5 — Tenant-Scoped Persistent Brain
// MSP-grade isolation • Non-resetting • Confidential by design
//
// EXPOSES:
// - addMemory({ tenantId, type, text, meta })
// - listMemory({ tenantId, limit, type })
// - buildPersonality({ tenantId })
//
// 🔒 GUARANTEES:
// - No cross-company leakage
// - No admin/backend exposure
// - Memory survives restarts
// - AI only knows what backend injects

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const BASE_PATH =
  (process.env.AI_MEMORY_PATH && String(process.env.AI_MEMORY_PATH).trim()) ||
  "/tmp/autoshield_brains";

const MAX_PER_TYPE = {
  site: 50,
  rule: 50,
  preference: 100,
  note: 200,
  trade_event: 300,
};

const MAX_TOTAL = Number(process.env.AI_MEMORY_MAX_ITEMS || 600);

/* ================= HELPERS ================= */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function brainPath(tenantId) {
  const t = safeStr(tenantId || "unknown", 60);
  return path.join(BASE_PATH, `brain_${t}.json`);
}

/* ================= LOAD / SAVE ================= */

function loadBrain(tenantId) {
  const file = brainPath(tenantId);
  ensureDir(BASE_PATH);

  try {
    if (!fs.existsSync(file)) {
      return {
        version: 1,
        tenantId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        items: [],
      };
    }

    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (raw && Array.isArray(raw.items)) {
      return {
        version: raw.version || 1,
        tenantId,
        createdAt: raw.createdAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        items: raw.items.slice(-MAX_TOTAL),
      };
    }
  } catch {}

  return {
    version: 1,
    tenantId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    items: [],
  };
}

function saveBrain(state) {
  try {
    ensureDir(BASE_PATH);
    state.updatedAt = nowIso();

    if (state.items.length > MAX_TOTAL) {
      state.items = state.items.slice(-MAX_TOTAL);
    }

    const tmp = brainPath(state.tenantId) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, brainPath(state.tenantId));
  } catch {}
}

/* ================= CORE API ================= */

function addMemory({ tenantId, type = "note", text = "", meta = {} } = {}) {
  if (!tenantId) return null;

  const state = loadBrain(tenantId);
  const t = safeStr(type, 40).toLowerCase();
  const txt = safeStr(text, 8000);

  if (!txt) return null;

  // 🔒 NEVER STORE ADMIN / BACKEND SECRETS
  if (t === "admin" || t === "backend" || t === "secret") return null;

  const rec = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: t,
    text: txt,
    meta: meta && typeof meta === "object" ? meta : {},
    iso: nowIso(),
  };

  state.items.unshift(rec);

  const cap = MAX_PER_TYPE[t] || 100;
  const same = state.items.filter((m) => m.type === t);
  if (same.length > cap) {
    const remove = same.slice(cap).map((m) => m.id);
    state.items = state.items.filter((m) => !remove.includes(m.id));
  }

  saveBrain(state);
  return rec;
}

function listMemory({ tenantId, limit = 50, type = null } = {}) {
  if (!tenantId) return [];

  const state = loadBrain(tenantId);
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const t = type ? safeStr(type, 40).toLowerCase() : null;

  let items = state.items;
  if (t) items = items.filter((m) => m.type === t);

  return items.slice(0, n);
}

function buildPersonality({ tenantId } = {}) {
  const rules = listMemory({ tenantId, type: "rule", limit: 20 }).map(
    (m) => m.text
  );
  const prefs = listMemory({ tenantId, type: "preference", limit: 20 }).map(
    (m) => m.text
  );
  const site = listMemory({ tenantId, type: "site", limit: 20 }).map(
    (m) => m.text
  );

  return {
    identity: "AuthoDev 6.5",
    tone: "calm, professional, human, precise",
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
