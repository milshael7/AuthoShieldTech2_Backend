// backend/src/services/learningEngine.js
// Self-Learning Adaptive Layer (Tenant Safe)

const fs = require("fs");
const path = require("path");

const BASE_PATH =
  process.env.LEARNING_STATE_DIR ||
  path.join("/tmp", "learning_engine");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function filePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `learn_${tenantId}.json`);
}

function defaultState() {
  return {
    symbols: {},
    global: {
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      confidenceBoost: 0,
      riskMultiplier: 1,
    },
  };
}

const CACHE = new Map();

/* ================= LOAD / SAVE ================= */

function load(tenantId) {
  if (CACHE.has(tenantId)) return CACHE.get(tenantId);

  let state = defaultState();
  try {
    const fp = filePath(tenantId);
    if (fs.existsSync(fp)) {
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      state = { ...state, ...raw };
    }
  } catch {}

  CACHE.set(tenantId, state);
  return state;
}

function save(tenantId) {
  const state = CACHE.get(tenantId);
  if (!state) return;

  try {
    fs.writeFileSync(filePath(tenantId), JSON.stringify(state, null, 2));
  } catch {}
}

/* ================= UPDATE AFTER TRADE ================= */

function recordTrade(tenantId, symbol, pnl) {
  const state = load(tenantId);

  if (!state.symbols[symbol]) {
    state.symbols[symbol] = {
      trades: 0,
      wins: 0,
      losses: 0,
      net: 0,
    };
  }

  const sym = state.symbols[symbol];

  sym.trades++;
  sym.net += pnl;
  state.global.totalTrades++;

  if (pnl > 0) {
    sym.wins++;
    state.global.totalWins++;
  } else {
    sym.losses++;
    state.global.totalLosses++;
  }

  const winRate =
    state.global.totalTrades > 0
      ? state.global.totalWins / state.global.totalTrades
      : 0;

  // Confidence & Risk Adaptation Logic
  if (winRate > 0.6) {
    state.global.confidenceBoost = 0.05;
    state.global.riskMultiplier = 1.2;
  } else if (winRate < 0.45) {
    state.global.confidenceBoost = -0.05;
    state.global.riskMultiplier = 0.7;
  } else {
    state.global.confidenceBoost = 0;
    state.global.riskMultiplier = 1;
  }

  save(tenantId);
}

function modifiers(tenantId) {
  const state = load(tenantId);

  return {
    confidenceBoost: state.global.confidenceBoost,
    riskMultiplier: state.global.riskMultiplier,
  };
}

module.exports = {
  recordTrade,
  modifiers,
};
