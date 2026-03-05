// backend/src/services/memoryBrain.js
// ==========================================================
// Permanent Memory Brain
// Stores Every Trade • Every Signal • Market Context
// Never Reset • Long-Term Intelligence Vault
// ==========================================================

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const BASE_PATH =
  process.env.MEMORY_BRAIN_DIR ||
  path.join("/tmp", "memory_brain");

const MAX_SIGNALS = 100000;
const MAX_TRADES = 100000;

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function brainPath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `memory_${tenantId}.json`);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ================= STATE ================= */

function defaultMemory() {
  return {
    version: 1,

    createdAt: Date.now(),
    updatedAt: Date.now(),

    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalSignals: 0,
    },

    trades: [],
    signals: [],
    marketStates: []
  };
}

const MEMORIES = new Map();

/* ================= LOAD ================= */

function load(tenantId) {

  if (MEMORIES.has(tenantId))
    return MEMORIES.get(tenantId);

  let mem = defaultMemory();
  const file = brainPath(tenantId);

  try {

    if (fs.existsSync(file)) {

      const raw = JSON.parse(
        fs.readFileSync(file, "utf-8")
      );

      mem = { ...mem, ...raw };

    }

  } catch {}

  MEMORIES.set(tenantId, mem);

  return mem;

}

/* ================= SAVE ================= */

function save(tenantId) {

  try {

    const mem = MEMORIES.get(tenantId);

    mem.updatedAt = Date.now();

    const file = brainPath(tenantId);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(mem, null, 2)
    );

    fs.renameSync(tmp, file);

  } catch {}

}

/* ================= RECORD TRADE ================= */

function recordTrade({
  tenantId,
  symbol,
  entry,
  exit,
  qty,
  pnl,
  risk,
  confidence,
  edge,
  volatility
}) {

  const mem = load(tenantId);

  const trade = {
    ts: Date.now(),
    symbol,
    entry,
    exit,
    qty,
    pnl,
    risk,
    confidence,
    edge,
    volatility
  };

  mem.trades.push(trade);

  if (mem.trades.length > MAX_TRADES)
    mem.trades = mem.trades.slice(-MAX_TRADES);

  mem.stats.totalTrades++;

  if (pnl > 0)
    mem.stats.wins++;
  else
    mem.stats.losses++;

  save(tenantId);

}

/* ================= RECORD SIGNAL ================= */

function recordSignal({
  tenantId,
  symbol,
  action,
  confidence,
  edge,
  price,
  volatility
}) {

  const mem = load(tenantId);

  const signal = {
    ts: Date.now(),
    symbol,
    action,
    confidence,
    edge,
    price,
    volatility
  };

  mem.signals.push(signal);

  if (mem.signals.length > MAX_SIGNALS)
    mem.signals = mem.signals.slice(-MAX_SIGNALS);

  mem.stats.totalSignals++;

  save(tenantId);

}

/* ================= RECORD MARKET STATE ================= */

function recordMarketState({
  tenantId,
  symbol,
  price,
  volatility
}) {

  const mem = load(tenantId);

  mem.marketStates.push({
    ts: Date.now(),
    symbol,
    price,
    volatility
  });

  if (mem.marketStates.length > MAX_SIGNALS)
    mem.marketStates =
      mem.marketStates.slice(-MAX_SIGNALS);

  save(tenantId);

}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {

  const mem = load(tenantId);

  return {
    stats: mem.stats,
    tradesStored: mem.trades.length,
    signalsStored: mem.signals.length
  };

}

/* ================= EXPORT ================= */

module.exports = {
  recordTrade,
  recordSignal,
  recordMarketState,
  snapshot
};
