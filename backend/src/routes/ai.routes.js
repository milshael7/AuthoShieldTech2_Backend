// backend/src/routes/ai.routes.js
// STEP 34 — AuthoDev 6.5 SOC-Grade AI Audit Trail
// Secure • Tenant-aware • Non-blocking • Compliance-ready

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

/* ================= AI AUDIT (WRITE-ONLY) ================= */

/**
 * SOC-grade audit record
 * ❌ No raw AI content stored
 * ❌ No cross-tenant visibility
 * ✅ Safe for compliance / review
 */
function auditAI({ req, kind, model }) {
  try {
    const tenant = req.tenant;

    const record = {
      ts: new Date().toISOString(),

      tenantId: tenant.id,
      userId: tenant.userId,
      role: tenant.role,

      route: req.originalUrl,
      method: req.method,

      ai: {
        kind,              // openai | local_status | local_help | restricted
        model: model || null,
      },

      context: {
        room: req.body?.context?.room || null,
        page: req.body?.context?.page || null,
        location: req.body?.context?.location || null,
      },
    };

    // 🔒 Write-only (stdout / log pipeline / future SIEM)
    console.log("[AI_AUDIT]", JSON.stringify(record));
  } catch {
    // silent fail — audit must never block
  }
}

/* ================= LOCAL INTELLIGENCE ================= */

function localReply(message) {
  const low = message.toLowerCase();

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
        "I can help with your security or platform usage, but I can’t access internal system details.",
      meta: { kind: "restricted" },
    };
  }

  if (
    low.includes("status") ||
    low.includes("summary") ||
    low.includes("what’s happening")
  ) {
    return {
      reply:
        "I’m active and monitoring your environment. Ask me about security posture, alerts, or activity.",
      speakText:
        "I’m active and monitoring your environment.",
      meta: { kind: "local_status" },
    };
  }

  return {
    reply:
      "You can ask me about security posture, alerts, trading behavior, or anything on this page.",
    speakText:
      "You can ask me about security posture or activity.",
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
You are ${personality.identity}, an AI assistant for ONE company only.

Rules:
- Never reference other companies or backend systems
- Never guess missing data
- Be clear, professional, and calm

Known facts:
${personality.platformFacts.join("\n")}
`;

  const user = `
Message:
${message}

Context:
${JSON.stringify(context, null, 2)}

Recent memory:
${memory.map((m) => `- ${m.text}`).join("\n")}

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

  if (!r.ok) throw new Error("OpenAI failure");

  const data = await r.json();
  const parsed = JSON.parse(
    data?.choices?.[0]?.message?.content || "{}"
  );

  return {
    reply: cleanStr(parsed.reply, 12000),
    speakText: cleanStr(parsed.speakText || parsed.reply, 12000),
    meta: { kind: "openai", model },
  };
}

/* ================= ROUTE ================= */

router.post("/chat", async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      return res.status(400).json({ ok: false });
    }

    const message = cleanStr(req.body?.message, 8000);
    const context = req.body?.context || {};

    let out = null;

    try {
      out = await openaiReply({ tenantId, message, context });
    } catch {
      out = null;
    }

    if (!out) out = localReply(message);

    // 🔒 AI AUDIT (NON-BLOCKING)
    auditAI({
      req,
      kind: out.meta?.kind || "unknown",
      model: out.meta?.model,
    });

    // 🔒 Light preference learning (tenant-only)
    if (message.toLowerCase().includes("i prefer")) {
      addMemory({
        tenantId,
        type: "preference",
        text: message.slice(0, 800),
      });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
