// backend/src/routes/ai.routes.js
// STEP 23 — AuthoDev 6.5 Tenant-Aware AI Routes
// Secure • MSP-grade • Voice + Text • Non-resetting memory
//
// 🔒 HARD GUARANTEES:
// - Every request is tenant-scoped
// - No backend/admin leakage
// - No cross-company knowledge
// - Same intelligence across rooms

const express = require("express");
const router = express.Router();

const {
  addMemory,
  listMemory,
  buildPersonality,
} = require("../lib/brain");

/* ================= HELPERS ================= */

function cleanStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

/* ================= LOCAL INTELLIGENCE (SAFE FALLBACK) ================= */

function localReply(message, context) {
  const low = message.toLowerCase();

  // 🔒 Never discuss backend or admin
  if (
    low.includes("backend") ||
    low.includes("admin") ||
    low.includes("database") ||
    low.includes("other company")
  ) {
    return {
      reply:
        "I can help with your security, trading, or platform usage, but I can’t access or discuss internal system details.",
      speakText:
        "I can help with your security, trading, or platform usage, but I can’t access internal system details.",
      meta: { kind: "restricted" },
    };
  }

  if (
    low.includes("status") ||
    low.includes("explain") ||
    low.includes("what’s happening") ||
    low.includes("summary")
  ) {
    return {
      reply:
        "I’m active and monitoring your environment. If you want, ask me about security posture, alerts, trading behavior, or recent activity.",
      speakText:
        "I’m active and monitoring your environment. Ask me about security posture, alerts, or recent activity.",
      meta: { kind: "local_status" },
    };
  }

  return {
    reply:
      "You can ask me about your security events, platform behavior, or anything you need help understanding.",
    speakText:
      "You can ask me about your security events, platform behavior, or anything you need help understanding.",
    meta: { kind: "local_help" },
  };
}

/* ================= OPENAI (OPTIONAL) ================= */

async function openaiReply({ tenantId, message, context }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model =
    cleanStr(process.env.OPENAI_CHAT_MODEL, 60) || "gpt-4o-mini";

  const personality = buildPersonality({ tenantId });
  const memory = listMemory({ tenantId, limit: 30 });

  const system = `
You are ${personality.identity}, an AI assistant for a single company.

Tone:
${personality.tone}

Rules:
- Speak like a calm, professional human.
- ONLY discuss the current company.
- NEVER mention backend, admin, or other tenants.
- If something is restricted, say so clearly.
- Never guess missing data.

Known company facts:
${personality.platformFacts.join("\n")}

Preferences:
${personality.preferences.join("\n")}

Hard rules:
${personality.rules.join("\n")}
`;

  const user = `
User message:
${message}

Context snapshot:
${JSON.stringify(context, null, 2)}

Recent memory:
${memory.map((m) => `- (${m.type}) ${m.text}`).join("\n")}

Respond ONLY with JSON:
{
  "reply": "...",
  "speakText": "..."
}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);

  const data = await r.json();
  const raw = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);

  return {
    reply: cleanStr(parsed.reply, 12000),
    speakText: cleanStr(parsed.speakText || parsed.reply, 12000),
    meta: { kind: "openai", model },
  };
}

/* ================= ROUTE ================= */

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    // 🔒 Tenant REQUIRED
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const message = cleanStr(req.body?.message, 8000);
    const context = req.body?.context || {};

    if (!message) {
      return res.status(400).json({
        ok: false,
        error: "Missing message",
      });
    }

    let out = null;

    // 1️⃣ Try OpenAI if configured
    try {
      out = await openaiReply({ tenantId, message, context });
    } catch {
      out = null;
    }

    // 2️⃣ Local fallback (safe)
    if (!out) out = localReply(message, context);

    // 3️⃣ Light learning (company-scoped)
    const low = message.toLowerCase();
    if (
      low.includes("remember") ||
      low.includes("from now on") ||
      low.includes("i prefer")
    ) {
      addMemory({
        tenantId,
        type: "preference",
        text: message.slice(0, 800),
      });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "AI error",
    });
  }
});

module.exports = router;
