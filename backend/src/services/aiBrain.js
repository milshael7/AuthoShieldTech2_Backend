// backend/src/services/aiBrain.js
// AutoShield AI Brain — Phase 3
// Conversational + Persistent + Trading Bias Engine
// Provides:
// - answer() for chat
// - decide() for trade bias overlay
// - persistent mindset
// - memory + notes

const fs = require("fs");
const path = require("path");

/* =========================================================
   CONFIG
========================================================= */

const BRAIN_PATH =
  process.env.AI_BRAIN_PATH?.trim() || "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 120);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 80);

const DEFAULT_MAX_REPLY_CHARS = Number(
  process.env.AI_BRAIN_MAX_REPLY_CHARS || 1800
);

/* =========================================================
   LOCKED WIN/LOSS MINDSET
========================================================= */

const MINDSET_VERSION = 2;

const DEFAULT_MINDSET = {
  version: MINDSET_VERSION,
  title: "AutoShield Win/Loss Mindset",
  summary:
    "Primary objective is capital protection. Loss is failure. Waiting is acceptable.",
  rules: [
    "Avoid loss before seeking profit.",
    "Loss = failure. Do not normalize losses.",
    "Waiting is acceptable. Forced trades are failure-prone.",
    "Confidence must reflect rule completion.",
    "After loss: tighten filters.",
    "Protect capital above all.",
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
   PERSISTENT BRAIN
========================================================= */

function defaultBrain() {
  return {
    version: 4,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    mindset: DEFAULT_MINDSET,
    history: [],
    notes: [],
  };
}

let brain = defaultBrain();

function loadBrain() {
  try {
    if (!fs.existsSync(BRAIN_PATH)) return;

    const raw = JSON.parse(fs.readFileSync(BRAIN_PATH, "utf-8"));
    brain = {
      ...defaultBrain(),
      ...raw,
    };

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

/* =========================================================
   TRADE BIAS ENGINE (USED BY tradeBrain.js)
========================================================= */

function decide(context = {}) {
  const last = safeNum(context.last, NaN);
  const paper = context.paper || {};
  const learn = paper.learnStats || {};
  const limits = paper.limits || {};

  if (!Number.isFinite(last)) {
    return { action: "WAIT", confidence: 0, edge: 0 };
  }

  // Basic adaptive tightening after loss
  if (limits.lossesToday >= 2) {
    return {
      action: "WAIT",
      confidence: 0.3,
      edge: 0,
    };
  }

  const edge = safeNum(learn.trendEdge, 0);
  const confidence = safeNum(learn.confidence, 0);

  // AI never overrides safety — only biases upward
  if (confidence > 0.75 && Math.abs(edge) > 0.0015) {
    return {
      action: edge > 0 ? "BUY" : "SELL",
      confidence: clamp(confidence + 0.05, 0, 1),
      edge: edge * 1.1,
    };
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

function answer(message = "", context = {}) {
  const msg = safeStr(message).toLowerCase();

  addHistory("user", message);

  if (msg.includes("mindset")) {
    const reply = mindsetText();
    addHistory("ai", reply);
    return reply;
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
      `Notes: ${brain.notes.length}`;
    addHistory("ai", reply);
    return reply;
  }

  const reply =
    "I analyze your trading context. Ask about mindset, losses, decisions, or performance.";

  addHistory("ai", reply);
  return reply;
}

function getSnapshot() {
  return {
    ok: true,
    updatedAt: brain.updatedAt,
    historyCount: brain.history.length,
    notesCount: brain.notes.length,
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
