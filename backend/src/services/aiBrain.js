// backend/src/services/aiBrain.js
// AutoProtect "Brain" — generates useful, non-repetitive replies from live context
// ✅ No web surfing here (safe). It only explains what your system is doing.
// ✅ Optional persistence so the brain doesn't reset on deploy (set BRAIN_STATE_PATH).

const fs = require("fs");
const path = require("path");

const BRAIN_STATE_PATH =
  (process.env.BRAIN_STATE_PATH && String(process.env.BRAIN_STATE_PATH).trim()) ||
  path.join("/tmp", "ai_brain_state.json");

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function loadState() {
  try {
    ensureDirFor(BRAIN_STATE_PATH);
    if (!fs.existsSync(BRAIN_STATE_PATH)) return { sessions: {} };
    return JSON.parse(fs.readFileSync(BRAIN_STATE_PATH, "utf-8"));
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  try {
    ensureDirFor(BRAIN_STATE_PATH);
    const tmp = BRAIN_STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, BRAIN_STATE_PATH);
  } catch {}
}

function fmtMoney(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  const ax = Math.abs(x);
  return `${sign}$${ax.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

function fmtPct(n, digits = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return (x * 100).toFixed(digits) + "%";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick(arr, seed) {
  if (!arr.length) return "";
  return arr[seed % arr.length];
}

function normalize(msg) {
  return String(msg || "").trim();
}

function lower(msg) {
  return normalize(msg).toLowerCase();
}

function extractSessionId(user) {
  // If you have user.id/email you can use it; otherwise single shared session.
  if (!user) return "global";
  return user.id || user.email || "global";
}

function buildScoreboard(ctx) {
  const p = ctx?.paper || {};
  const bal = Number(p.balance ?? 0);
  const wins = Number(p.wins ?? p.realized?.wins ?? 0);
  const losses = Number(p.losses ?? p.realized?.losses ?? 0);
  const grossProfit = Number(p.grossProfit ?? p.realized?.grossProfit ?? 0);
  const grossLoss = Number(p.grossLoss ?? p.realized?.grossLoss ?? 0);
  const net = Number(p.net ?? p.pnl ?? p.realized?.net ?? 0);

  const feePaid = Number(p.feePaid ?? p.costs?.feePaid ?? 0);
  const slip = Number(p.slippageCost ?? p.costs?.slippageCost ?? 0);
  const spr = Number(p.spreadCost ?? p.costs?.spreadCost ?? 0);

  const ticksSeen = Number(p.ticksSeen ?? p.learnStats?.ticksSeen ?? 0);
  const conf = Number(p.confidence ?? p.learnStats?.confidence ?? 0);
  const decision = String(p.decision ?? p.learnStats?.decision ?? "WAIT");
  const reason = String(p.decisionReason ?? p.learnStats?.lastReason ?? "—");

  return {
    bal, wins, losses, grossProfit, grossLoss, net,
    feePaid, slip, spr,
    ticksSeen, conf, decision, reason
  };
}

function buildRiskRulesFromEnv() {
  // These mirror your paperTrader env vars so AI can explain them.
  const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
  const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
  const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
  const TP = Number(process.env.PAPER_TP_PCT || 0.004);
  const SL = Number(process.env.PAPER_SL_PCT || 0.003);
  const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

  const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
  const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
  const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
  const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

  const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
  const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
  const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

  return {
    START_BAL,
    WARMUP_TICKS,
    RISK_PCT,
    TP,
    SL,
    MIN_EDGE,
    FEE_RATE,
    SLIPPAGE_BP,
    SPREAD_BP,
    COOLDOWN_MS,
    MAX_USD_PER_TRADE,
    MAX_TRADES_PER_DAY,
    MAX_DRAWDOWN_PCT
  };
}

function summarizeState(ctx) {
  const s = buildScoreboard(ctx);
  const last = Number(ctx?.last ?? 0);
  const symbol = String(ctx?.symbol ?? "—");
  const mode = String(ctx?.mode ?? "Paper");

  const lines = [
    `Mode: ${mode} • Symbol: ${symbol} • Last price: ${last ? fmtMoney(last, 2).replace("$", "") : "—"}`,
    `Balance: ${fmtMoney(s.bal)} • Net P&L: ${fmtMoney(s.net)} • Wins/Losses: ${s.wins}/${s.losses}`,
    `Total Gain: ${fmtMoney(s.grossProfit)} • Total Loss: ${fmtMoney(s.grossLoss)}`,
    `Costs — Fees: ${fmtMoney(s.feePaid)} • Slippage: ${fmtMoney(s.slip)} • Spread: ${fmtMoney(s.spr)}`,
    `Learning — Ticks: ${s.ticksSeen} • Confidence: ${fmtPct(s.conf, 0)} • Decision: ${s.decision} • Reason: ${s.reason}`
  ];
  return lines.join("\n");
}

function answerWhyEnter(ctx) {
  const s = buildScoreboard(ctx);
  const rules = buildRiskRulesFromEnv();

  const confOk = s.conf >= 0.55;
  const warmOk = s.ticksSeen >= rules.WARMUP_TICKS;
  const decision = s.decision;

  const checks = [
    `Warmup: ${warmOk ? "OK" : "NOT READY"} (ticks ${s.ticksSeen}/${rules.WARMUP_TICKS})`,
    `Confidence: ${confOk ? "OK" : "LOW"} (${fmtPct(s.conf, 0)} / needs ~55%+)`,
    `Decision: ${decision}`,
    `Reason tag: ${s.reason}`
  ].join("\n");

  const explain = [
    `Here’s the exact checklist that leads to an entry:`,
    checks,
    ``,
    `Current rules (paper): TP=${fmtPct(rules.TP, 2)} • SL=${fmtPct(rules.SL, 2)} • Max per trade=${fmtMoney(rules.MAX_USD_PER_TRADE)} • Cooldown=${Math.round(rules.COOLDOWN_MS/1000)}s`,
  ].join("\n");

  return explain;
}

function answerFeesTooHigh(ctx) {
  const rules = buildRiskRulesFromEnv();
  return [
    `You’re right — if trades are tiny, fees/spread/slippage can eat the whole move.`,
    ``,
    `Right now your simulator uses:`,
    `• Fee rate: ${fmtPct(rules.FEE_RATE, 2)} per side`,
    `• Spread: ${rules.SPREAD_BP} bp • Slippage: ${rules.SLIPPAGE_BP} bp`,
    `• Max USD per trade cap: ${fmtMoney(rules.MAX_USD_PER_TRADE)}`,
    ``,
    `Fix: enforce a MIN trade notional (example: $25–$100 minimum) and/or lower fee assumptions.`,
    `If you want, we’ll add env vars like PAPER_MIN_USD_PER_TRADE and PAPER_MIN_EDGE_FOR_ENTRY.`
  ].join("\n");
}

function answerMemory(ctx) {
  return [
    `Two different “memories” matter here:`,
    `1) PaperTrader state (balance, trades, learning stats) — saved by PAPER_STATE_PATH (your Render Disk).`,
    `2) Brain memory (chat continuity) — saved by BRAIN_STATE_PATH (separate file).`,
    ``,
    `If you set:`,
    `• PAPER_STATE_PATH=/var/data/paper_state.json`,
    `you already stopped paper resets. To stop chat resets too, set:`,
    `• BRAIN_STATE_PATH=/var/data/ai_brain_state.json`
  ].join("\n");
}

function genericHelp(ctx, msg) {
  const s = buildScoreboard(ctx);
  const rules = buildRiskRulesFromEnv();

  const prompts = [
    `Ask me: “why did you enter?”, “what’s my net P&L?”, “show wins/losses”, “explain fees”, “show risk rules”, “is live enabled?”`,
    `Right now: Decision=${s.decision}, Confidence=${fmtPct(s.conf,0)}, Net=${fmtMoney(s.net)}`
  ];

  // Slight variety so it doesn't repeat the same opener forever
  const seed = hashCode((msg || "") + "|" + String(s.ticksSeen));
  const openers = [
    "Got you.",
    "Alright — here’s what I see.",
    "Yep, checking the dashboard now.",
    "I’m reading the current snapshot."
  ];

  return [
    pick(openers, seed),
    summarizeState(ctx),
    ``,
    `Risk rules snapshot: TP=${fmtPct(rules.TP,2)} • SL=${fmtPct(rules.SL,2)} • Warmup=${rules.WARMUP_TICKS} ticks • Max/trade=${fmtMoney(rules.MAX_USD_PER_TRADE)}`,
    ``,
    prompts.join("\n")
  ].join("\n");
}

function buildReply({ message, context, user }) {
  const msg = normalize(message);
  const m = lower(msg);

  // Context safety: never crash on missing context
  const ctx = context || {};

  // Basic intent routing
  if (m.includes("summary") || m.includes("status") || m.includes("scoreboard")) {
    return summarizeState(ctx);
  }

  if (m.includes("why") && (m.includes("enter") || m.includes("buy") || m.includes("trade"))) {
    return answerWhyEnter(ctx);
  }

  if (m.includes("fee") || m.includes("fees") || m.includes("slippage") || m.includes("spread") || m.includes("tiny trade")) {
    return answerFeesTooHigh(ctx);
  }

  if (m.includes("memory") || m.includes("reset") || m.includes("brain") || m.includes("doesn't reset")) {
    return answerMemory(ctx);
  }

  if (m.includes("risk") || m.includes("rules") || m.includes("take profit") || m.includes("stop loss") || m.includes("tp") || m.includes("sl")) {
    const r = buildRiskRulesFromEnv();
    return [
      `Current paper risk rules:`,
      `• Start balance: ${fmtMoney(r.START_BAL)}`,
      `• Warmup ticks: ${r.WARMUP_TICKS}`,
      `• TP: ${fmtPct(r.TP, 2)} • SL: ${fmtPct(r.SL, 2)}`,
      `• Min edge: ${fmtPct(r.MIN_EDGE, 3)}`,
      `• Cooldown: ${Math.round(r.COOLDOWN_MS / 1000)}s`,
      `• Max USD per trade: ${fmtMoney(r.MAX_USD_PER_TRADE)}`,
      `• Max trades/day: ${r.MAX_TRADES_PER_DAY}`,
      `• Max drawdown: ${fmtPct(r.MAX_DRAWDOWN_PCT, 0)}`
    ].join("\n");
  }

  // Live questions (if frontend includes it in context later)
  if (m.includes("live")) {
    const live = ctx?.live || {};
    const enabled = !!live.enabled;
    const dryRun = !!live.dryRun;
    const armed = !!live.armed;
    const keys = !!live.keysPresent;
    return [
      `Live readiness:`,
      `• Keys present: ${keys}`,
      `• Enabled: ${enabled}`,
      `• Armed: ${armed}`,
      `• Dry-run: ${dryRun}`,
      ``,
      `Reminder: keep Dry-run ON until you explicitly decide to allow real orders.`
    ].join("\n");
  }

  return genericHelp(ctx, msg);
}

function rememberTurn(sessionId, userText, aiText) {
  const st = loadState();
  if (!st.sessions) st.sessions = {};
  if (!st.sessions[sessionId]) st.sessions[sessionId] = { last: [], updatedAt: Date.now() };

  const s = st.sessions[sessionId];
  s.last.push({ t: Date.now(), you: String(userText || ""), ai: String(aiText || "") });
  while (s.last.length > 20) s.last.shift(); // keep short
  s.updatedAt = Date.now();

  saveState(st);
}

function getMemory(sessionId) {
  const st = loadState();
  const s = st.sessions?.[sessionId];
  return s?.last || [];
}

async function chat({ message, context, user }) {
  const sessionId = extractSessionId(user);

  // We keep memory stored but we don’t “hallucinate” with it — it’s for future upgrade.
  // For now, just stop repetition & answer from real context.
  const reply = buildReply({ message, context, user });

  rememberTurn(sessionId, message, reply);

  return {
    reply,
    meta: {
      brainStatePath: BRAIN_STATE_PATH,
      memoryTurns: getMemory(sessionId).length
    }
  };
}

module.exports = { chat };
