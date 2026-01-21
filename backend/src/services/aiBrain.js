// backend/src/services/aiBrain.js
// Persistent "Brain" for AutoProtect explanations + memory (NO trading execution here)
// - Stores short-term memory + last decisions + notes
// - Survives deploys when AI_BRAIN_PATH points to a Render Disk path
// - Uses ONLY the context your frontend sends (paper stats, wins/losses, last price, etc.)

const fs = require("fs");
const path = require("path");

const BRAIN_PATH =
  (process.env.AI_BRAIN_PATH && String(process.env.AI_BRAIN_PATH).trim()) ||
  "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 80);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 50);

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function money(n, digits = 2) {
  const x = safeNum(n, NaN);
  if (!Number.isFinite(x)) return "—";
  return "$" + x.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pct01(n, digits = 0) {
  const x = safeNum(n, NaN);
  if (!Number.isFinite(x)) return "—";
  return (x * 100).toFixed(digits) + "%";
}

function nowIso() {
  return new Date().toISOString();
}

function defaultBrain() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    // conversation memory (short & safe)
    history: [], // [{ts, role:'user'|'ai', text}]
    notes: [],   // [{ts, text}]

    // last known context snapshot
    lastContext: null,

    // behavior config (safe defaults)
    config: {
      style: "business_clear",
      maxHistory: MAX_HISTORY,
      maxNotes: MAX_NOTES,
    },
  };
}

let brain = defaultBrain();
let saveTimer = null;

function loadBrain() {
  try {
    ensureDirFor(BRAIN_PATH);
    if (!fs.existsSync(BRAIN_PATH)) return false;
    const raw = fs.readFileSync(BRAIN_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    const base = defaultBrain();
    brain = {
      ...base,
      ...parsed,
      config: { ...base.config, ...(parsed.config || {}) },
      history: Array.isArray(parsed.history) ? parsed.history : base.history,
      notes: Array.isArray(parsed.notes) ? parsed.notes : base.notes,
    };

    // clamp sizes
    brain.history = brain.history.slice(-MAX_HISTORY);
    brain.notes = brain.notes.slice(-MAX_NOTES);

    return true;
  } catch {
    return false;
  }
}

function saveBrainNow() {
  try {
    ensureDirFor(BRAIN_PATH);
    brain.updatedAt = nowIso();

    const safe = {
      ...brain,
      history: brain.history.slice(-MAX_HISTORY),
      notes: brain.notes.slice(-MAX_NOTES),
    };

    const tmp = BRAIN_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, BRAIN_PATH);
  } catch {
    // never crash server due to brain persistence
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBrainNow();
  }, 600);
}

loadBrain();

// ------------------ memory helpers ------------------

function addHistory(role, text) {
  const clean = String(text || "").trim();
  if (!clean) return;

  brain.history.push({ ts: Date.now(), role, text: clean });
  if (brain.history.length > MAX_HISTORY) brain.history = brain.history.slice(-MAX_HISTORY);
  scheduleSave();
}

function addNote(text) {
  const clean = String(text || "").trim();
  if (!clean) return;

  brain.notes.push({ ts: Date.now(), text: clean });
  if (brain.notes.length > MAX_NOTES) brain.notes = brain.notes.slice(-MAX_NOTES);
  scheduleSave();
}

function setLastContext(ctx) {
  brain.lastContext = ctx || null;
  scheduleSave();
}

function getSnapshot() {
  return {
    ok: true,
    brainPath: BRAIN_PATH,
    createdAt: brain.createdAt,
    updatedAt: brain.updatedAt,
    historyCount: brain.history.length,
    notesCount: brain.notes.length,
    lastContext: brain.lastContext ? true : false,
    config: brain.config,
  };
}

function resetBrain() {
  brain = defaultBrain();
  saveBrainNow();
}

// ------------------ reasoning / reply engine ------------------

function normalizeMessage(s) {
  return String(s || "").toLowerCase().trim();
}

function extractPaper(ctx) {
  const paper = ctx?.paper || ctx?.context?.paper || {};
  const learn = paper.learnStats || paper.learnStats === null ? paper.learnStats : paper.learnStats;
  return {
    running: !!paper.running,
    balance: safeNum(paper.balance, 0),
    pnl: safeNum(paper.pnl, 0),
    realized: {
      wins: safeNum(paper.realized?.wins, safeNum(paper.wins, 0)),
      losses: safeNum(paper.realized?.losses, safeNum(paper.losses, 0)),
      grossProfit: safeNum(paper.realized?.grossProfit, safeNum(paper.grossProfit, 0)),
      grossLoss: safeNum(paper.realized?.grossLoss, safeNum(paper.grossLoss, 0)),
      net: safeNum(paper.realized?.net, safeNum(paper.net, safeNum(paper.pnl, 0))),
    },
    costs: {
      feePaid: safeNum(paper.costs?.feePaid, safeNum(paper.feePaid, 0)),
      slippageCost: safeNum(paper.costs?.slippageCost, safeNum(paper.slippageCost, 0)),
      spreadCost: safeNum(paper.costs?.spreadCost, safeNum(paper.spreadCost, 0)),
    },
    learnStats: {
      ticksSeen: safeNum(paper.learnStats?.ticksSeen, safeNum(paper.ticksSeen, 0)),
      confidence: safeNum(paper.learnStats?.confidence, safeNum(paper.confidence, 0)),
      volatility: safeNum(paper.learnStats?.volatility, 0),
      trendEdge: safeNum(paper.learnStats?.trendEdge, 0),
      decision: String(paper.learnStats?.decision || paper.decision || "WAIT"),
      lastReason: String(paper.learnStats?.lastReason || paper.decisionReason || "—"),
      lastTickTs: paper.learnStats?.lastTickTs || null,
    },
    position: paper.position || null,
    tradesCount: Array.isArray(paper.trades) ? paper.trades.length : 0,
  };
}

function extractTop(ctx) {
  const symbol = String(ctx?.symbol || ctx?.context?.symbol || "BTCUSD");
  const mode = String(ctx?.mode || ctx?.context?.mode || "Paper");
  const last = safeNum(ctx?.last ?? ctx?.context?.last, NaN);
  return { symbol, mode, last };
}

function buildScoreboard(p) {
  return [
    `Paper Balance: ${money(p.balance)}`,
    `Net P&L: ${money(p.realized.net)} (Wins: ${p.realized.wins} / Losses: ${p.realized.losses})`,
    `Total Gain: ${money(p.realized.grossProfit)} • Total Loss: ${money(p.realized.grossLoss)}`,
    `Fees: ${money(p.costs.feePaid)} • Slippage: ${money(p.costs.slippageCost)} • Spread: ${money(p.costs.spreadCost)}`,
  ].join("\n");
}

function buildDecisionLine(p) {
  return [
    `Decision: ${p.learnStats.decision}`,
    `Confidence: ${pct01(p.learnStats.confidence, 0)} • Volatility: ${pct01(p.learnStats.volatility, 0)} • Edge: ${pct01(p.learnStats.trendEdge, 2)}`,
    `Reason: ${p.learnStats.lastReason}`,
    `Ticks Seen: ${p.learnStats.ticksSeen}`,
  ].join("\n");
}

function answer(message, context) {
  const msg = String(message || "").trim();
  const m = normalizeMessage(msg);

  const top = extractTop(context);
  const paper = extractPaper(context);

  // update brain memory
  addHistory("user", msg);
  setLastContext({
    ts: Date.now(),
    symbol: top.symbol,
    mode: top.mode,
    last: top.last,
    paper: {
      running: paper.running,
      balance: paper.balance,
      net: paper.realized.net,
      wins: paper.realized.wins,
      losses: paper.realized.losses,
      decision: paper.learnStats.decision,
      reason: paper.learnStats.lastReason,
      confidence: paper.learnStats.confidence,
      ticksSeen: paper.learnStats.ticksSeen,
    },
  });

  // Commands (admin-safe, but we still keep them simple)
  if (m === "help" || m.includes("what can you do") || m.includes("commands")) {
    const reply =
      `AutoProtect Brain (persistent)\n` +
      `Ask things like:\n` +
      `- "why did you enter?"\n` +
      `- "show scoreboard"\n` +
      `- "wins and losses"\n` +
      `- "fees and costs"\n` +
      `- "what is the current decision?"\n` +
      `- "explain last trade"\n` +
      `- "add note: ..."\n`;
    addHistory("ai", reply);
    return reply;
  }

  if (m.startsWith("add note:") || m.startsWith("note:")) {
    const text = msg.split(":").slice(1).join(":").trim();
    addNote(text);
    const reply = `Saved note. (${brain.notes.length}/${MAX_NOTES})`;
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("scoreboard") || m.includes("wins") || m.includes("loss") || m.includes("p&l") || m.includes("pnl")) {
    const reply =
      `Scoreboard (${top.symbol} • ${top.mode})\n` +
      buildScoreboard(paper);
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("fees") || m.includes("slippage") || m.includes("spread") || m.includes("cost")) {
    const reply =
      `Costs breakdown\n` +
      `Fees Paid: ${money(paper.costs.feePaid)}\n` +
      `Slippage Cost: ${money(paper.costs.slippageCost)}\n` +
      `Spread Cost: ${money(paper.costs.spreadCost)}\n` +
      `Tip: If fees dominate, increase minimum trade notional OR lower fee model in paper config.`;
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("why") || m.includes("enter") || m.includes("buy") || m.includes("sell") || m.includes("decision") || m.includes("reason")) {
    const lastPx = Number.isFinite(top.last) ? `Last Price: ${money(top.last).replace("$", "")}` : `Last Price: —`;

    const posLine = paper.position
      ? `Open Position: ${paper.position.side} ${paper.position.symbol} • Entry ${money(paper.position.entry).replace("$", "")} • Qty ${paper.position.qty}`
      : `Open Position: none`;

    const reply =
      `Decision report (${top.symbol} • ${top.mode})\n` +
      `${lastPx}\n` +
      `${posLine}\n\n` +
      buildDecisionLine(paper) +
      `\n\n` +
      `If you want tighter behavior: raise MIN_EDGE, raise warmup ticks, and enforce a minimum USD notional so fees don’t eat the trade.`;
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("brain") || m.includes("memory") || m.includes("reset") || m.includes("persist")) {
    const reply =
      `Brain status\n` +
      `- Brain file: ${BRAIN_PATH}\n` +
      `- Updated: ${brain.updatedAt}\n` +
      `- History: ${brain.history.length} messages\n` +
      `- Notes: ${brain.notes.length}\n\n` +
      `To make sure this never resets on deploy:\n` +
      `Set AI_BRAIN_PATH to your Render Disk mount, e.g. /var/data/ai_brain.json`;
    addHistory("ai", reply);
    return reply;
  }

  // fallback: be helpful, not repetitive
  const reply =
    `I got you. Ask me one of these so I can answer with real numbers:\n` +
    `- "show scoreboard"\n` +
    `- "why did you enter?"\n` +
    `- "fees and costs"\n` +
    `- "what is the current decision?"\n`;
  addHistory("ai", reply);
  return reply;
}

module.exports = {
  answer,
  addNote,
  getSnapshot,
  resetBrain,
};
