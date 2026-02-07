// backend/src/routes/ai.routes.js
// STEP 4 — Proactive, Operator-Grade AI
// AutoShield speaks FIRST when state changes

const express = require("express");
const router = express.Router();

const { addMemory, listMemory } = require("../lib/brain");

/* ================= UTIL ================= */

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

/* ================= SNAPSHOT ================= */

function summarizeTradingContext(context) {
  const p = context?.paper || {};

  return {
    symbol: cleanStr(context?.symbol, 20) || "—",
    mode: cleanStr(context?.mode, 20) || "—",
    last: Number(context?.last) || null,

    running: !!p.running,
    equity: Number(p.equity ?? p.cashBalance ?? 0),
    pnl: Number(p.pnl ?? p.net ?? 0),
    unreal: Number(p.unrealizedPnL ?? 0),

    wins: Number(p.wins ?? 0),
    losses: Number(p.losses ?? 0),

    decision: cleanStr(p.decision, 40) || "WAIT",
    reason: cleanStr(p.lastReason || p.decisionReason, 240) || "—",
    confidence: Number(p.confidence ?? 0),

    halted: !!p?.limits?.halted,
    haltReason: p?.limits?.haltReason || null,

    position: p.position
      ? {
          symbol: cleanStr(p.position.symbol, 20),
          entry: Number(p.position.entry),
          qty: Number(p.position.qty),
        }
      : null,
  };
}

/* ================= PROACTIVE LOGIC ================= */

function proactiveSpeech(snap) {
  // HARD STOPS
  if (snap.halted) {
    return `Trading is halted due to ${snap.haltReason}. Capital protection is active.`;
  }

  // ACTIVE POSITION
  if (snap.position) {
    return `We are currently in a position on ${snap.position.symbol}. 
    Entry price ${snap.position.entry}. 
    Unrealized P and L is ${snap.unreal.toFixed(2)} dollars. 
    I’m monitoring for exit conditions.`;
  }

  // WAIT STATE
  if (snap.decision === "WAIT") {
    return `I’m waiting for a higher confidence setup. 
    Current confidence is ${Math.round(snap.confidence * 100)} percent.`;
  }

  // ENTRY
  if (snap.decision === "BUY") {
    return `A buy condition is forming. 
    Confidence is ${Math.round(snap.confidence * 100)} percent. 
    Reason: ${snap.reason}.`;
  }

  // EXIT
  if (snap.decision === "CLOSE" || snap.decision === "SELL") {
    return `Exit conditions detected. 
    Reason: ${snap.reason}.`;
  }

  return null;
}

/* ================= LOCAL INTELLIGENCE ================= */

function localReply(message, context) {
  const snap = summarizeTradingContext(context);
  const proactive = proactiveSpeech(snap);

  // User explicitly asks for explanation
  const low = message.toLowerCase();
  if (
    low.includes("explain") ||
    low.includes("status") ||
    low.includes("what's happening")
  ) {
    return {
      reply: `
Mode: ${snap.mode}
Symbol: ${snap.symbol}

Decision: ${snap.decision}
Confidence: ${Math.round(snap.confidence * 100)}%

P&L: ${snap.pnl.toFixed(2)}
Unrealized: ${snap.unreal.toFixed(2)}

Reason:
${snap.reason}
      `.trim(),
      speakText: proactive || "Here’s the current trading status.",
      meta: { kind: "explain" },
    };
  }

  // Default
  return {
    reply:
      "I’m actively monitoring the market. You can ask why I’m waiting, entering, or managing risk.",
    speakText: proactive,
    meta: { kind: "proactive" },
  };
}

/* ================= CHAT ================= */

router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000);
    const context = req.body?.context || {};

    const memoryItems = listMemory({ limit: 25 });
    const snap = summarizeTradingContext(context);

    // Local-first (fast + deterministic)
    const out = localReply(message, context);

    // Lightweight learning
    if (
      message.toLowerCase().includes("remember") ||
      message.toLowerCase().includes("from now on")
    ) {
      addMemory({ type: "preference", text: message.slice(0, 800) });
    }

    return res.json({
      ok: true,
      reply: out.reply,
      speakText: out.speakText,
      meta: {
        ...out.meta,
        snapshot: snap,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* ================= MEMORY ================= */

router.get("/memory", (req, res) => {
  if (!hasOwnerAccess(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  const limit = clampInt(req.query.limit, 1, 500, 50);
  return res.json({ ok: true, items: listMemory({ limit }) });
});

/* ================= STATUS ================= */

router.get("/brain/status", (req, res) => {
  return res.json({
    ok: true,
    memoryCount: listMemory({ limit: 500 }).length,
    time: new Date().toISOString(),
  });
});

module.exports = router;
