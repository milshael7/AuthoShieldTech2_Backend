// backend/src/services/aiVoiceBridge.js
// STEP 6 — Event → AI Voice Bridge
// Purpose: Convert live trading events into natural spoken AI messages

const { traderEvents } = require("./paperTrader");

/* ================= CONFIG ================= */

// What events are allowed to speak
const VOICE_RULES = {
  ENTRY: { speak: true, level: "info" },
  EXIT: { speak: true, level: "info" },
  HALT: { speak: true, level: "critical" },
};

// Optional: mute info-level speech (set true to silence entries/exits)
const MUTE_INFO = false;

/* ================= HELPERS ================= */

function speak(payload) {
  // This function is intentionally simple.
  // Later, you can route this to:
  // - WebSocket
  // - Redis pub/sub
  // - Push notifications
  // - Direct VoiceAI injection

  console.log("[AI VOICE]", payload.text);

  // 🔑 This return object is what VoiceAI / UI can consume later
  return payload;
}

function confidencePct(c) {
  if (!Number.isFinite(c)) return null;
  return Math.round(c * 100);
}

/* ================= EVENT HANDLERS ================= */

traderEvents.on("ENTRY", (e) => {
  if (!VOICE_RULES.ENTRY.speak) return;
  if (MUTE_INFO) return;

  const conf = confidencePct(e.confidence);

  const text =
    `Entering ${e.symbol}. ` +
    (conf !== null ? `Confidence ${conf} percent. ` : "") +
    (e.reason ? `Reason: ${e.reason}.` : "");

  speak({
    type: "ENTRY",
    level: "info",
    text,
    meta: e,
  });
});

traderEvents.on("EXIT", (e) => {
  if (!VOICE_RULES.EXIT.speak) return;
  if (MUTE_INFO) return;

  const pnl =
    typeof e.pnl === "number"
      ? `${e.pnl >= 0 ? "Profit" : "Loss"} ${e.pnl.toFixed(2)} dollars.`
      : "";

  const text =
    `Exiting ${e.symbol}. ` +
    pnl +
    (e.reason ? ` Reason: ${e.reason}.` : "");

  speak({
    type: "EXIT",
    level: "info",
    text,
    meta: e,
  });
});

traderEvents.on("HALT", (e) => {
  if (!VOICE_RULES.HALT.speak) return;

  const text =
    `Trading halted. ${e.reason}. ` +
    (e.equity ? `Equity is now ${Number(e.equity).toFixed(2)}.` : "");

  speak({
    type: "HALT",
    level: "critical",
    text,
    meta: e,
  });
});

/* ================= BOOT ================= */

// This file has side effects by design.
// Requiring it once activates the bridge.

console.log("[AI VOICE] Event bridge active");

module.exports = {
  speak, // exported for future manual calls
};
