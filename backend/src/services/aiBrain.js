// backend/src/services/aiBrain.js
// Phase 10 — Institutional AI Signal Fusion Engine
// Conversational + Persistent + Regime-Aware Trade Bias Layer
// Tenant Safe • Deterministic • Noise Suppressed

const fs = require("fs");

/* =========================================================
   CONFIG
========================================================= */

const BRAIN_PATH =
  process.env.AI_BRAIN_PATH?.trim() || "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 120);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 80);

const MAX_REPLY_CHARS = Number(
  process.env.AI_BRAIN_MAX_REPLY_CHARS || 1800
);

const SIGNAL_MEMORY_LIMIT = 50;

/* =========================================================
   LOCKED WIN/LOSS MINDSET
========================================================= */

const MINDSET_VERSION = 3;

const DEFAULT_MINDSET = {
  version: MINDSET_VERSION,
  title: "AutoShield Institutional Capital Doctrine",
  summary:
    "Primary objective is capital protection. Loss minimization overrides profit seeking.",
  rules: [
    "Capital preservation > profit.",
    "Loss = system failure signal.",
    "Do not normalize losses.",
    "Waiting is superior to forced trades.",
    "After degradation: tighten filters.",
    "Signal alignment required before biasing.",
  ],
};

/* =========================================================
   UTILS
========================================================= */

function safeStr(v, max = 5000) {
  return String(v ?? "").trim().slice(0, max);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowIso() {
  return new Date().toISOString();
}

/* =========================================================
   PERSISTENT BRAIN STATE
========================================================= */

function defaultBrain() {
  return {
    version: 5,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    mindset: DEFAULT_MINDSET,

    history: [],
    notes: [],

    signalMemory: [],   // recent trade signals
    falseSignalCount: 0,
  };
}

let brain = defaultBrain();

function loadBrain() {
  try {
    if (!fs.existsSync(BRAIN_PATH)) return;

    const raw = JSON.parse(fs.readFileSync(BRAIN_PATH, "utf-8"));

    brain = { ...defaultBrain(), ...raw };

    if (!brain.mindset || brain.mindset.version < MINDSET_VERSION) {
      brain.mindset = DEFAULT_MINDSET;
    }
  } catch {}
}

function saveBrain() {
  try {
    brain.updatedAt = nowIso();
    fs.writeFileSync(
      BRAIN_PATH,
      JSON.stringify(brain, null, 2)
    );
  } catch {}
}

loadBrain();

/* =========================================================
   MEMORY HELPERS
========================================================= */

function addHistory(role, text) {
  brain.history.push({
    ts: Date.now(),
    role,
    text: safeStr(text),
  });

  if (brain.history.length > MAX_HISTORY) {
    brain.history = brain.history.slice(-MAX_HISTORY);
  }

  saveBrain();
}

function addNote(text) {
  brain.notes.push({
    ts: Date.now(),
    text: safeStr(text),
  });

  if (brain.notes.length > MAX_NOTES) {
    brain.notes = brain.notes.slice(-MAX_NOTES);
  }

  saveBrain();
}

function recordSignal(result) {
  brain.signalMemory.push({
    ts: Date.now(),
    action: result.action,
    confidence: result.confidence,
    edge: result.edge,
  });

  if (brain.signalMemory.length > SIGNAL_MEMORY_LIMIT) {
    brain.signalMemory =
      brain.signalMemory.slice(-SIGNAL_MEMORY_LIMIT);
  }

  saveBrain();
}

/* =========================================================
   SIGNAL CONSISTENCY MODEL
========================================================= */

function signalConsistencyScore() {
  if (brain.signalMemory.length < 5) return 1;

  const recent = brain.signalMemory.slice(-10);
  const buys = recent.filter(s => s.action === "BUY").length;
  const sells = recent.filter(s => s.action === "SELL").length;

  const imbalance = Math.abs(buys - sells) / 10;

  return clamp(1 - imbalance * 0.5, 0.7, 1.1);
}

/* =========================================================
   TRADE BIAS ENGINE
========================================================= */

function decide(context = {}) {
  const last = safeNum(context.last, NaN);
  const paper = context.paper || {};
  const learn = paper.learnStats || {};
  const limits = paper.limits || {};
  const regime = paper.regime || "neutral";

  if (!Number.isFinite(last)) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  /* ---- Hard Safety ---- */

  if (limits.lossesToday >= 2) {
    return { action: "WAIT", confidence: 0.2, edge: 0 };
  }

  /* ---- Base Signal ---- */

  const baseEdge = safeNum(learn.trendEdge, 0);
  const baseConfidence = safeNum(learn.confidence, 0);

  /* ---- Noise Suppression ---- */

  if (Math.abs(baseEdge) < 0.0005) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  /* ---- Regime Bias ---- */

  let edge = baseEdge;
  let confidence = baseConfidence;

  if (regime === "trend") {
    edge *= 1.1;
    confidence *= 1.05;
  }

  if (regime === "range") {
    edge *= 0.8;
    confidence *= 0.85;
  }

  /* ---- Consistency Dampener ---- */

  const consistency = signalConsistencyScore();
  confidence *= consistency;

  /* ---- False Signal Dampening ---- */

  if (brain.falseSignalCount >= 3) {
    confidence *= 0.8;
  }

  confidence = clamp(confidence, 0, 1);

  if (confidence > 0.75 && Math.abs(edge) > 0.0015) {
    const action = edge > 0 ? "BUY" : "SELL";

    const result = {
      action,
      confidence,
      edge,
    };

    recordSignal(result);
    return result;
  }

  return {
    action: "WAIT",
    confidence,
    edge,
  };
}

/* =========================================================
   CHAT INTERFACE
========================================================= */

function mindsetText() {
  const m = brain.mindset;
  return [
    `${m.title} (v${m.version})`,
    "",
    m.summary,
    "",
    ...m.rules.map((r) => `- ${r}`),
  ].join("\n");
}

function answer(message = "") {
  const msg = safeStr(message).toLowerCase();
  addHistory("user", message);

  if (msg.includes("mindset")) {
    const reply = mindsetText();
    addHistory("ai", reply);
    return reply.slice(0, MAX_REPLY_CHARS);
  }

  if (msg.startsWith("add note:")) {
    const note = message.split(":").slice(1).join(":").trim();
    addNote(note);
    const reply = "Note saved.";
    addHistory("ai", reply);
    return reply;
  }

  if (msg.includes("brain status")) {
    const reply =
      `Brain file: ${BRAIN_PATH}\n` +
      `History: ${brain.history.length}\n` +
      `Notes: ${brain.notes.length}\n` +
      `Signals: ${brain.signalMemory.length}`;
    addHistory("ai", reply);
    return reply;
  }

  const reply =
    "AI layer active. Monitoring signal quality and capital protection doctrine.";

  addHistory("ai", reply);
  return reply;
}

function getSnapshot() {
  return {
    ok: true,
    updatedAt: brain.updatedAt,
    historyCount: brain.history.length,
    notesCount: brain.notes.length,
    signalMemory: brain.signalMemory.length,
    mindsetVersion: brain.mindset.version,
  };
}

function resetBrain() {
  brain = defaultBrain();
  saveBrain();
}

/* ========================================================= */

module.exports = {
  answer,
  decide,
  addNote,
  getSnapshot,
  resetBrain,
};
