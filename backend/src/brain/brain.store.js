// ==========================================================
// FILE: backend/src/brain/brain.store.js
// VERSION: v2.0 (Adaptive Memory Engine)
// PURPOSE:
// - Persistent AI memory
// - Track performance by pattern, symbol, and setup
// ==========================================================

const fs = require("fs");
const path = require("path");

const BRAIN_PATH = path.join(__dirname, "brain.memory.json");

/* =========================================================
INIT
========================================================= */

function ensureBrain() {
  if (!fs.existsSync(BRAIN_PATH)) {
    fs.writeFileSync(
      BRAIN_PATH,
      JSON.stringify(
        {
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

          // 🔥 NEW
          symbols: {},

          // 🔥 NEW
          patterns: {},

          // 🔥 NEW
          setups: {},

          history: [],
        },
        null,
        2
      )
    );
  }
}

/* =========================================================
READ / WRITE
========================================================= */

function readBrain() {
  ensureBrain();
  return JSON.parse(fs.readFileSync(BRAIN_PATH, "utf-8"));
}

function writeBrain(brain) {
  brain.lastUpdated = Date.now();
  fs.writeFileSync(BRAIN_PATH, JSON.stringify(brain, null, 2));
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

  const profit = Number(pnl) || 0;
  const sym = String(symbol || "UNKNOWN").toUpperCase();

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

  /* ================= SYMBOL TRACKING ================= */

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

  if (profit > 0) s.wins++;
  else s.losses++;

  /* ================= PATTERN TRACKING ================= */

  if (!brain.patterns[pattern]) {
    brain.patterns[pattern] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
    };
  }

  const p = brain.patterns[pattern];

  p.trades++;
  p.net += profit;

  if (profit > 0) p.wins++;
  else p.losses++;

  /* ================= SETUP TRACKING ================= */

  if (!brain.setups[setup]) {
    brain.setups[setup] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
      avgConfidence: 0,
    };
  }

  const st = brain.setups[setup];

  st.trades++;
  st.net += profit;

  if (profit > 0) st.wins++;
  else st.losses++;

  // rolling confidence avg
  st.avgConfidence =
    (st.avgConfidence * (st.trades - 1) + confidence) / st.trades;

  /* ================= HISTORY ================= */

  brain.history.push({
    ts: Date.now(),
    symbol: sym,
    pnl: profit,
    pattern,
    setup,
    confidence,
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
  if (fs.existsSync(BRAIN_PATH)) {
    fs.unlinkSync(BRAIN_PATH);
  }

  ensureBrain();

  return { ok: true };
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
