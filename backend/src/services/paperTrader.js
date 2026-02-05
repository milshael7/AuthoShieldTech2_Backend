// backend/src/services/paperTrader.js
// Paper trading engine — FULL REPLACEMENT (SAFE)

const fs = require('fs');
const path = require('path');

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const BASELINE_PCT = Number(process.env.PAPER_BASELINE_PCT || 0.03);
const MAX_PCT = Number(process.env.PAPER_OWNER_MAX_PCT || 0.50);
const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);

const TIER_SIZE = Number(process.env.PAPER_TIER_SIZE || 100000);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE = process.env.PAPER_STATE_PATH || path.join('/tmp', 'paper_state.json');

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function defaultState() {
  return {
    running: true,

    startBalance: START_BAL,
    cashBalance: START_BAL,
    equity: START_BAL,
    peakEquity: START_BAL,
    pnl: 0,

    realized: {
      wins: 0,
      losses: 0,
      grossProfit: 0,
      grossLoss: 0,
      net: 0,
    },

    costs: {
      feePaid: 0,
      slippageCost: 0,
      spreadCost: 0,
    },

    trades: [],
    position: null,
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      trendEdge: 0,
      decision: 'WAIT',
      lastReason: 'boot',
      lastTickTs: null,
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lossesToday: 0,
      forceBaseline: false,
      lastTradeTs: 0,
      halted: false,
      haltReason: null,
    },

    owner: {
      baselinePct: BASELINE_PCT,
      maxPct: MAX_PCT,
      maxTradesPerDay: MAX_TRADES_DAY,
    },

    buf: { BTCUSDT: [], ETHUSDT: [] },
  };
}

let state = defaultState();

/* ---------- persistence ---------- */
function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}
function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE));
      state = { ...defaultState(), ...raw };
    }
  } catch {
    state = defaultState();
  }
}
load();

/* ---------- safety ---------- */
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
    state.limits.forceBaseline = false;
  }
}

function updateEquity(price) {
  if (state.position) {
    state.equity = state.cashBalance + (state.position.qty * price);
  } else {
    state.equity = state.cashBalance;
  }
  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function checkDrawdown() {
  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

/* ---------- buffers ---------- */
function pushBuf(sym, price) {
  const b = state.buf[sym] || [];
  b.push(price);
  while (b.length > 60) b.shift();
  state.buf[sym] = b;
}

/* ---------- sizing ---------- */
function tierBase() {
  return Math.max(TIER_SIZE, Math.floor(state.equity / TIER_SIZE) * TIER_SIZE);
}

function sizePct() {
  if (state.limits.forceBaseline) return BASELINE_PCT;
  const base = tierBase();
  const top = base + TIER_SIZE;
  const p = clamp((state.equity - base) / (top - base), 0, 1);
  return clamp(BASELINE_PCT + p * (MAX_PCT - BASELINE_PCT), BASELINE_PCT, MAX_PCT);
}

function tradeSizeUsd() {
  return Math.max(25, Math.min(state.cashBalance - 1, tierBase() * sizePct()));
}

/* ---------- trading ---------- */
function tick(sym, price, ts = Date.now()) {
  if (!state.running || state.limits.halted) return;

  checkDaily(ts);
  state.learnStats.ticksSeen++;
  state.lastPriceBySymbol[sym] = price;

  pushBuf(sym, price);

  updateEquity(price);
  checkDrawdown();

  save();
}

function snapshot() {
  const pos = state.position;
  const lastPx = pos ? state.lastPriceBySymbol[pos.symbol] : null;
  const unreal = pos && lastPx ? (lastPx - pos.entry) * pos.qty : 0;

  return {
    ...state,
    unrealizedPnL: unreal,
    sizing: {
      tierBase: tierBase(),
      sizePct: sizePct(),
      sizeUsd: tradeSizeUsd(),
    },
  };
}

function start() { state.running = true; }
function hardReset() { state = defaultState(); save(); }

module.exports = { start, tick, snapshot, hardReset };
