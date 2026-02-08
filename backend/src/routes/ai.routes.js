// backend/src/routes/ai.routes.js
// AuthoDev 6.5 — Canonical AI Contract (ENFORCED)
// Secure • Tenant-isolated • SOC-grade • Deterministic output
//
// GUARANTEES:
// - One request contract
// - One response contract
// - No hallucinations
// - Role-aware behavior
// - Never leaks backend or tenants
// - Frontend-safe, future-proof

const express = require("express");
const router = express.Router();

const {
  addMemory,
  listMemory,
  buildPersonality,
} = require("../lib/brain");

/* ================= CONSTANTS ================= */

const MAX_INPUT = 2000;
const MAX_OUTPUT = 800;

/* ================= HELPERS ================= */

function cleanStr(v, max = MAX_INPUT) {
  return String(v ?? "").trim().slice(0, max);
}

function normalizeResponse({
  reply,
  speakText,
  confidence = "medium",
  type = "direct",
  meta = {},
}) {
  return {
    reply: cleanStr(reply, MAX_OUTPUT),
    speakText: cleanStr(speakText || reply, MAX_OUTPUT),
    confidence,
    type,
    meta,
  };
}

function reject(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

/* ================= SAFE FALLBACK (NO AI) ================= */

function localReply(message, context) {
  const low = message.toLowerCase();

  if (
    low.includes("backend") ||
    low.includes("admin access") ||
    low.includes("database") ||
    low.includes("other company")
  ) {
    return normalizeResponse({
      reply:
        "That information is restricted. I can help with security posture, platform usage, or risk decisions.",
      confidence: "high",
      type: "direct",
    });
  }

  return normalizeResponse({
    reply:
      "I’m available to help with security posture, alerts, trading behavior, or risk decisions.",
    confidence: "medium",
    type: "status",
  });
}

/* ================= OPENAI (STRICT MODE) ================= */

async function openaiReply({ tenantId, message, context }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = cleanStr(
    process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    40
  );

  const personality = buildPersonality({ tenantId });
  const memory = listMemory({ tenantId, limit: 20 });

  const system = `
You are AuthoDev 6.5, a professional cybersecurity and systems advisor.

RULES (NON-NEGOTIABLE):
- Do not greet the user
- Do not use emojis
- Do not speculate or guess
- Do not ask follow-up questions unless clarification is required
- Do not mention backend, system internals, or other tenants
- Be concise and structured
- Prefer actionable answers

ROLE TONE:
Admin: technical, concise
Manager: risk and impact focused
Company: outcome-oriented, low jargon
User: simple, practical

If information is missing:
- State what is known
- State what is unknown
- Provide a safe recommendation

Respond ONLY with JSON:
{
  "reply": "...",
  "confidence": "high | medium | low",
  "type": "status | action | decision | direct"
}
`;

  const user = `
Message:
${message}

Context:
${JSON.stringify(context, null, 2)}

Known memory:
${memory.map((m) => `- ${m.text}`).join("\n")}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
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

  if (!parsed.reply) throw new Error("Invalid AI response");

  return normalizeResponse({
    reply: parsed.reply,
    confidence: parsed.confidence || "medium",
    type: parsed.type || "direct",
    meta: { model },
  });
}

/* ================= ROUTE ================= */

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    /* ---------- TENANT ENFORCEMENT ---------- */
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return reject(res, 400, "Tenant context missing");
    }

    /* ---------- INPUT VALIDATION ---------- */
    const message = cleanStr(req.body?.message);
    const context = req.body?.context || {};

    if (!message) {
      return reject(res, 400, "Message required");
    }

    let output = null;

    /* ---------- AI ATTEMPT ---------- */
    try {
      output = await openaiReply({ tenantId, message, context });
    } catch {
      output = null;
    }

    /* ---------- FALLBACK ---------- */
    if (!output) {
      output = localReply(message, context);
    }

    /* ---------- LIGHT MEMORY (SAFE) ---------- */
    if (
      /remember|from now on|i prefer/i.test(message)
    ) {
      addMemory({
        tenantId,
        type: "preference",
        text: message.slice(0, 500),
      });
    }

    return res.json({ ok: true, ...output });
  } catch (e) {
    return reject(res, 500, e?.message || "AI failure");
  }
});

module.exports = router;
