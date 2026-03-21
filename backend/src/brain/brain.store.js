// ==========================================================
// FILE: backend/src/brain/brain.store.js
// VERSION: v2.1 (Hardened Memory Engine)
// PURPOSE:
// - Persistent AI memory
// - Safe, atomic, corruption-resistant storage
// ==========================================================

const fs = require("fs");
const path = require("path");

const BRAIN_PATH = path.join(__dirname, "brain.memory.json");
const TMP_PATH = path.join(__dirname, "brain.memory.tmp.json");

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
DEFAULT STRUCTURE
========================================================= */

function defaultBrain() {
  return {
    createdAt: Date.now(),
    lastUpdated: Date.now(),

    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalWinUSD: 0,
      totalLossUSD: 0,
      netPnL: 0,
      maxBalance: 0,
    },

    symbols: {},
    patterns: {},
    setups: {},

    history: [],
  };
}

/* =========================================================
INIT
========================================================= */

function ensureBrain() {
  try {
    if (!fs.existsSync(BRAIN_PATH)) {
      fs.writeFileSync(
        BRAIN_PATH,
        JSON.stringify(defaultBrain(), null, 2)
      );
    }
  } catch (err) {
    console.error("Brain init error:", err.message);
  }
}

/* =========================================================
SAFE READ
========================================================= */

function readBrain() {
  ensureBrain();

  try {
    const raw = fs.readFileSync(BRAIN_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    // minimal shape validation
    if (!parsed.stats || !parsed.history) {
      throw new Error("Invalid brain structure");
    }

    return parsed;
  } catch (err) {
    console.error("Brain read failed, rebuilding:", err.message);

    const fresh = defaultBrain();
    writeBrain(fresh);
    return fresh;
  }
}

/* =========================================================
SAFE WRITE (ATOMIC)
========================================================= */

function writeBrain(brain) {
  try {
    brain.lastUpdated = Date.now();

    // write temp first
    fs.writeFileSync(TMP_PATH, JSON.stringify(brain, null, 2));

    // then replace original
    fs.renameSync(TMP_PATH, BRAIN_PATH);
  } catch (err) {
    console.error("Brain write error:", err.message);
  }
}

/* =========================================================
UPDATE MEMORY
========================================================= */

function recordTrade({
  symbol,
  pnl,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  const brain = readBrain();

  const profit = safeNum(pnl, 0);
  const sym = String(symbol || "UNKNOWN").toUpperCase();
  const pat = String(pattern || "unknown");
  const set = String(setup || "unknown");

  /* ================= GLOBAL ================= */

  brain.stats.totalTrades++;

  if (profit > 0) {
    brain.stats.wins++;
    brain.stats.totalWinUSD += profit;
  } else {
    brain.stats.losses++;
    brain.stats.totalLossUSD += Math.abs(profit);
  }

  brain.stats.netPnL += profit;

  /* ================= SYMBOL ================= */

  if (!brain.symbols[sym]) {
    brain.symbols[sym] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
    };
  }

  const s = brain.symbols[sym];

  s.trades++;
  s.net += profit;
  profit > 0 ? s.wins++ : s.losses++;

  /* ================= PATTERN ================= */

  if (!brain.patterns[pat]) {
    brain.patterns[pat] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
    };
  }

  const p = brain.patterns[pat];

  p.trades++;
  p.net += profit;
  profit > 0 ? p.wins++ : p.losses++;

  /* ================= SETUP ================= */

  if (!brain.setups[set]) {
    brain.setups[set] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
      avgConfidence: 0,
    };
  }

  const st = brain.setups[set];

  st.trades++;
  st.net += profit;
  profit > 0 ? st.wins++ : st.losses++;

  st.avgConfidence =
    (safeNum(st.avgConfidence) * (st.trades - 1) +
      safeNum(confidence)) /
    st.trades;

  /* ================= HISTORY ================= */

  brain.history.push({
    ts: Date.now(),
    symbol: sym,
    pnl: profit,
    pattern: pat,
    setup: set,
    confidence: safeNum(confidence),
  });

  if (brain.history.length > 1000) {
    brain.history.shift();
  }

  writeBrain(brain);
}

/* =========================================================
QUERY HELPERS
========================================================= */

function getSymbolStats(symbol) {
  const brain = readBrain();
  return brain.symbols?.[symbol] || null;
}

function getPatternStats(pattern) {
  const brain = readBrain();
  return brain.patterns?.[pattern] || null;
}

function getSetupStats(setup) {
  const brain = readBrain();
  return brain.setups?.[setup] || null;
}

/* =========================================================
RESET
========================================================= */

function resetBrain() {
  try {
    if (fs.existsSync(BRAIN_PATH)) {
      fs.unlinkSync(BRAIN_PATH);
    }

    ensureBrain();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  ensureBrain,
  readBrain,
  writeBrain,
  recordTrade,
  getSymbolStats,
  getPatternStats,
  getSetupStats,
  resetBrain,
  BRAIN_PATH,
};
