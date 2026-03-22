// ==========================================================
// 🔒 PROTECTED CORE FILE — MAINTENANCE SAFE
// FILE: brain.store.js
// VERSION: v3.0 (Tenant-Aware + Safe + Observable)
// ==========================================================
//
// PURPOSE:
// - Persistent AI memory (per tenant)
// - Atomic writes (no corruption)
// - Debug visibility
// - Safe recovery
//
// ==========================================================

const fs = require("fs");
const path = require("path");

/* =========================================================
PATHS
========================================================= */

const BASE_PATH = path.join(__dirname, "memory");

if (!fs.existsSync(BASE_PATH)) {
  fs.mkdirSync(BASE_PATH, { recursive: true });
}

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getPath(tenantId) {
  const id = String(tenantId || "__default__");
  return {
    main: path.join(BASE_PATH, `brain_${id}.json`),
    tmp: path.join(BASE_PATH, `brain_${id}.tmp.json`),
    backup: path.join(BASE_PATH, `brain_${id}.bak.json`),
  };
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
    },

    symbols: {},
    patterns: {},
    setups: {},

    history: [],
  };
}

/* =========================================================
ENSURE FILE
========================================================= */

function ensureBrain(tenantId) {
  const { main } = getPath(tenantId);

  try {
    if (!fs.existsSync(main)) {
      fs.writeFileSync(main, JSON.stringify(defaultBrain(), null, 2));
    }
  } catch (err) {
    console.error("Brain init error:", err.message);
  }
}

/* =========================================================
READ
========================================================= */

function readBrain(tenantId) {
  const { main, backup } = getPath(tenantId);

  ensureBrain(tenantId);

  try {
    const raw = fs.readFileSync(main, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed.stats || !parsed.history) {
      throw new Error("Invalid structure");
    }

    return parsed;

  } catch (err) {
    console.error("⚠️ Brain corrupted. Attempting recovery...");

    try {
      if (fs.existsSync(backup)) {
        const raw = fs.readFileSync(backup, "utf-8");
        return JSON.parse(raw);
      }
    } catch {}

    const fresh = defaultBrain();
    writeBrain(tenantId, fresh);
    return fresh;
  }
}

/* =========================================================
WRITE (ATOMIC + BACKUP)
========================================================= */

function writeBrain(tenantId, brain) {
  const { main, tmp, backup } = getPath(tenantId);

  try {
    brain.lastUpdated = Date.now();

    fs.writeFileSync(tmp, JSON.stringify(brain, null, 2));

    // backup current
    if (fs.existsSync(main)) {
      fs.copyFileSync(main, backup);
    }

    fs.renameSync(tmp, main);

  } catch (err) {
    console.error("Brain write error:", err.message);
  }
}

/* =========================================================
RECORD TRADE (CORE LEARNING)
========================================================= */

function recordTrade({
  tenantId,
  symbol,
  pnl,
  pattern = "unknown",
  setup = "unknown",
  confidence = 0,
}) {
  const brain = readBrain(tenantId);

  const profit = safeNum(pnl, 0);
  const sym = String(symbol || "UNKNOWN").toUpperCase();
  const pat = String(pattern);
  const set = String(setup);

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
    brain.symbols[sym] = { trades: 0, wins: 0, losses: 0, net: 0 };
  }

  const s = brain.symbols[sym];

  s.trades++;
  s.net += profit;
  profit > 0 ? s.wins++ : s.losses++;

  /* ================= PATTERN ================= */

  if (!brain.patterns[pat]) {
    brain.patterns[pat] = { trades: 0, wins: 0, losses: 0, net: 0 };
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
    (safeNum(st.avgConfidence) * (st.trades - 1) + safeNum(confidence)) /
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

  writeBrain(tenantId, brain);
}

/* =========================================================
DEBUG SNAPSHOT (🔥 IMPORTANT FOR YOU)
========================================================= */

function getBrainSnapshot(tenantId) {
  const brain = readBrain(tenantId);

  return {
    stats: brain.stats,
    symbols: brain.symbols,
    patterns: brain.patterns,
    setups: brain.setups,
    lastTrades: brain.history.slice(-20),
  };
}

/* =========================================================
RESET
========================================================= */

function resetBrain(tenantId) {
  const { main } = getPath(tenantId);

  try {
    if (fs.existsSync(main)) {
      fs.unlinkSync(main);
    }

    ensureBrain(tenantId);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  readBrain,
  writeBrain,
  recordTrade,
  getBrainSnapshot,
  resetBrain,
};
