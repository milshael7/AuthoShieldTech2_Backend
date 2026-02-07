// backend/src/services/aiAnnouncer.js
// AutoShield AI Announcer
// - Generates human-readable + speakable messages
// - Used by paperTrader and live trader
// - NO OpenAI required (routes already handle voice)

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function pct(n) {
  return `${Math.round(Number(n) * 100)}%`;
}

/* ================= ANNOUNCERS ================= */

function announceOpen({ symbol, entry, qty, riskPct }) {
  const text = [
    `New trade opened.`,
    `Symbol ${symbol}.`,
    `Entry ${money(entry)}.`,
    `Size ${qty.toFixed(4)} units.`,
    `Risk ${pct(riskPct)}.`,
  ];

  return {
    type: "trade_open",
    reply: text.join(" "),
    speakText: text.join(" "),
  };
}

function announceClose({ symbol, entry, exit, pnl, reason }) {
  const win = pnl >= 0;

  const text = [
    `Trade closed.`,
    `Symbol ${symbol}.`,
    `Entry ${money(entry)}.`,
    `Exit ${money(exit)}.`,
    `Result ${money(pnl)}.`,
    win ? `That was a win.` : `That was a loss.`,
    reason ? `Reason: ${reason}.` : "",
  ];

  return {
    type: "trade_close",
    reply: text.join(" "),
    speakText: text.join(" "),
  };
}

function announceHalt({ reason }) {
  const text = [
    `Trading has been halted.`,
    `Reason: ${reason}.`,
    `No new trades will be taken.`,
  ];

  return {
    type: "halt",
    reply: text.join(" "),
    speakText: text.join(" "),
  };
}

module.exports = {
  announceOpen,
  announceClose,
  announceHalt,
};
