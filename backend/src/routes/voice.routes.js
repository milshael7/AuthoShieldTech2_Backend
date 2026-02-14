// backend/src/routes/voice.routes.js
// Enterprise Voice TTS Bridge
// Node 18+ Native Fetch Compatible
// Secure • Tenant-isolated • Rate-limited • Timeout Protected • Audited

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { authRequired } = require("../middleware/auth");

/* =========================================================
   CONFIG
========================================================= */

const OPENAI_TIMEOUT_MS = 10000;

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 6000) {
  return String(v ?? "").trim().slice(0, max);
}

/* =========================================================
   TENANT-AWARE RATE LIMIT
========================================================= */

const voiceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VOICE_RATELIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
});

/* =========================================================
   AUDIT
========================================================= */

function auditVoice({ req, provider, model, chars }) {
  try {
    console.log(
      "[VOICE_AUDIT]",
      JSON.stringify({
        ts: new Date().toISOString(),
        tenantId: req.tenant?.id || null,
        userId: req.user?.id || null,
        role: req.user?.role || null,
        provider,
        model,
        chars,
        route: req.originalUrl,
      })
    );
  } catch {}
}

/* =========================================================
   MIDDLEWARE
========================================================= */

router.use(authRequired);
router.use(voiceLimiter);

/* =========================================================
   STATUS
========================================================= */

router.get("/status", (req, res) => {
  const provider = (process.env.VOICE_PROVIDER || "")
    .trim()
    .toLowerCase();

  return res.json({
    ok: true,
    configured:
      provider === "openai" &&
      !!process.env.OPENAI_API_KEY,
    provider: provider || null,
    model: process.env.OPENAI_TTS_MODEL || null,
    time: new Date().toISOString(),
  });
});

/* =========================================================
   TTS
========================================================= */

router.post("/tts", async (req, res) => {
  try {
    if (typeof fetch !== "function") {
      return res.status(500).json({
        ok: false,
        error: "Global fetch not available (Node < 18?)",
      });
    }

    const provider = (process.env.VOICE_PROVIDER || "")
      .trim()
      .toLowerCase();

    const text = cleanStr(req.body?.text, 8000);
    const voice =
      cleanStr(req.body?.voice, 50) ||
      process.env.OPENAI_TTS_VOICE ||
      "alloy";

    const format =
      cleanStr(req.body?.format, 20) || "mp3";

    if (!text) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing text" });
    }

    if (provider !== "openai") {
      return res.status(501).json({
        ok: false,
        error: "Voice provider not enabled",
        detail:
          "Set VOICE_PROVIDER=openai to enable server-side TTS.",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({
        ok: false,
        error: "OPENAI_API_KEY missing",
      });
    }

    const model =
      process.env.OPENAI_TTS_MODEL ||
      "gpt-4o-mini-tts";

    /* ---------------- TIMEOUT GUARD ---------------- */

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OPENAI_TIMEOUT_MS
    );

    const r = await fetch(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          format,
          input: text,
        }),
      }
    );

    clearTimeout(timeout);

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      return res.status(502).json({
        ok: false,
        error: "TTS provider error",
        detail: errTxt || `HTTP ${r.status}`,
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());

    auditVoice({
      req,
      provider,
      model,
      chars: text.length,
    });

    const mime =
      format === "wav"
        ? "audio/wav"
        : format === "aac"
        ? "audio/aac"
        : format === "opus"
        ? "audio/ogg"
        : "audio/mpeg";

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Voice generation failed",
    });
  }
});

module.exports = router;
