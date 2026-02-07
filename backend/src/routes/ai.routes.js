// backend/src/routes/ai.routes.js
// Smarter AI routes (non-robotic) + real paperTrader awareness
// ✅ Full live trading context
// ✅ Voice-ready responses (speakText)
// ✅ Memory support
// ✅ OpenAI optional (safe fallback)

const express = require("express");
const router = express.Router();

const { addMemory, listMemory } = require("../lib/brain");
const paperTrader = require("../services/paperTrader");

// Optional existing service (if you already have it)
let aiBrain = null;
try {
  aiBrain = require("../services/aiBrain");
} catch {
  aiBrain = null;
}

/* ================= HELPERS ================= */

function cleanStr(v, max = 8000) {
  return String(v || "").trim().slice(0, max);
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function hasOwnerAccess(req) {
  const key = cleanStr(process.env.AI_OWNER_KEY, 200);
  if (!key) return true;
  const sent = cleanStr(req.headers["x-owner-key"], 200);
  return !!sent && sent === key;
}

/* ================= CONTEXT NORMALIZATION ================= */

function summarizeTradingContext(context) {
  const p = context?.paper || {};
  const symbol = cleanStr(context?.symbol, 20) || "—";
  const mode = cleanStr(context?.trading_mode || context?.mode, 20) || "—";
  const last = Number(context?.last);

  return {
    symbol,
    mode,
    last: Number.isFinite(last) ? last : null,

    running: !!p.running,
    equity: Number(p.equity ?? 0),
    cash: Number(p.cashBalance ?? 0),
    unrealized: Number(p.unrealizedPnL ?? 0),

    wins: Number(p.realized?.wins ?? 0),
    losses: Number(p.realized?.losses ?? 0),
    net: Number(p.realized?.net ?? 0),

    decision: cleanStr(p.decision, 40) || "WAIT",
    confidence: Number(p.confidence ?? 0),
    decisionReason: cleanStr(p.decisionReason, 300) || "—",

    position: p.position
      ? {
          symbol: cleanStr(p.position.symbol, 20),
          entry: Number(p.position.entry),
          qty: Number(p.position.qty),
          ageMs: Date.now() - Number(p.position.ts),
        }
      : null,
  };
}

/* ================= LOCAL SMART REPLY ================= */

function localReply(message, context) {
  const m = cleanStr(message, 2000).toLowerCase();
  const snap = summarizeTradingContext(context);

  if (
    m.includes("explain") ||
    m.includes("status") ||
    m.includes("what's going on") ||
    m.includes("summary")
  ) {
    const text = `
Here’s what’s happening right now.

Mode: ${snap.mode}
Decision: ${snap.decision} (${Math.round(snap.confidence * 100)}% confidence)

Equity: $${snap.equity.toFixed(2)}
Unrealized P&L: $${snap.unrealized.toFixed(2)}
Wins / Losses: ${snap.wins} / ${snap.losses}

${
  snap.position
    ? `Open position in ${snap.position.symbol} at $${snap.position.entry}`
    : "No open position right now."
}

Reason: ${snap.decisionReason}
`.trim();

    return {
      reply: text,
      speakText: text.replace(/\n+/g, ". "),
      meta: { kind: "dashboard_status", snap },
    };
  }

  if (m.includes("why") && (m.includes("buy") || m.includes("sell") || m.includes("trade"))) {
    const text = `
Decision: ${snap.decision}
Confidence: ${Math.round(snap.confidence * 100)}%

Reason:
${snap.decisionReason}
`.trim();

    return {
      reply: text,
      speakText: text.replace(/\n+/g, ". "),
      meta: { kind: "trade_reason", snap },
    };
  }

  return {
    reply:
      "I’m live and connected to your trading engine. You can ask me why a trade happened, why I’m waiting, or what I’m watching next.",
    speakText:
      "I’m live and connected to your trading engine. Ask me why a trade happened, or what I’m waiting for.",
    meta: { kind: "help" },
  };
}

/* ================= OPENAI (OPTIONAL) ================= */

async function openaiReply(message, context, memoryItems) {
  const apiKey = cleanStr(process.env.OPENAI_API_KEY, 200);
  if (!apiKey) return null;

  const snap = summarizeTradingContext(context);

  const system = `
You are AutoShield, a calm, confident trading assistant.
You speak naturally, like a human operator.
You NEVER invent trades.
You ONLY explain what is in the snapshot.
If something is unknown, you say so.
Return JSON only.
`;

  const user = `
User said: ${message}

Trading snapshot:
${JSON.stringify(snap, null, 2)}

Return:
{
  "reply": "screen text",
  "speakText": "spoken version"
}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) return null;

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    return {
      reply: cleanStr(parsed.reply, 12000),
      speakText: cleanStr(parsed.speakText || parsed.reply, 12000),
      meta: { kind: "openai" },
    };
  } catch {
    return null;
  }
}

/* ================= ROUTES ================= */

router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000);
    if (!message) return res.status(400).json({ ok: false, error: "Missing message" });

    const clientContext = req.body?.context || {};

    let paperSnapshot = null;
    try {
      paperSnapshot = paperTrader.snapshot();
    } catch {}

    const context = {
      ...clientContext,
      paper: paperSnapshot,
    };

    const memoryItems = listMemory({ limit: 25 });

    if (aiBrain?.answer) {
      const out = await aiBrain.answer(message, context);
      if (out?.reply) {
        return res.json({ ok: true, reply: out.reply, speakText: out.speakText || out.reply });
      }
    }

    let out = null;
    try {
      out = await openaiReply(message, context, memoryItems);
    } catch {}

    if (!out) out = localReply(message, context);

    if (message.toLowerCase().includes("remember")) {
      addMemory({ type: "preference", text: message.slice(0, 800) });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= MEMORY ================= */

router.get("/memory", (req, res) => {
  if (!hasOwnerAccess(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  const limit = clampInt(req.query.limit, 1, 500, 50);
  const type = cleanStr(req.query.type, 40) || null;
  return res.json({ ok: true, items: listMemory({ limit, type }) });
});

module.exports = router;
