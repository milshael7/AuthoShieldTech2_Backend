// backend/src/services/paperTrader.js
// Paper trading engine with REAL TIME wallet flow rules:
// - Trading wallet starts funded, storehouse starts 0
// - Trading wallet has a CAP; overflow goes to STOREHOUSE
// - If trading wallet drops below TRIGGER, storehouse top-ups the trading wallet
// - Trades sized by % (owner can override risk % anytime)
// - Persistence uses PAPER_STATE_PATH (Render Disk recommended)

const fs = require("fs");
const path = require("path");

// ---------- ENV DEFAULTS ----------
const START_TRADING_WALLET = Number(process.env.PAPER_START_BALANCE || 100000);
const START_STOREHOUSE_WALLET = Number(process.env.PAPER_STOREHOUSE_START || 0);

const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

// % sizing
const BASE_RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.12);     // 12% base (your example)
const MAX_RISK_PCT = Number(process.env.PAPER_MAX_RISK_PCT || 0.50);  // 50% max

// take profit / stop loss
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism knobs
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

// safety
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY_DEFAULT = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 200); // paper can be high
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// anti “tiny trades / fee dominance”
const MIN_USD_PER_TRADE = Number(process.env.PAPER_MIN_USD_PER_TRADE || 50);
const MIN_NET_TP_USD = Number(process.env.PAPER_MIN_NET_TP_USD || 1.0);

// wallet flow rules (your numbers)
const TRADING_WALLET_CAP_DEFAULT = Number(process.env.PAPER_TRADING_WALLET_CAP || 200000);
const TOPUP_TRIGGER_DEFAULT = Number(process.env.PAPER_TOPUP_TRIGGER || 500000);
const TOPUP_AMOUNT_DEFAULT = Number(process.env.PAPER_TOPUP_AMOUNT || 5000);

// persistence path
const STATE_FILE =
  (process.env.PAPER_STATE_PATH && String(process.env.PAPER_STATE_PATH).trim()) ||
  path.join("/tmp", "paper_state.json");

// ---------- HELPERS ----------
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

// ---------- STATE ----------
function defaultState() {
  return {
    running: true,

    wallets: {
      trading: START_TRADING_WALLET,
      storehouse: START_STOREHOUSE_WALLET
    },

    startBalance: START_TRADING_WALLET,
    pnl: 0,
    realized: { wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, net: 0 },
    costs: { feePaid: 0, slippageCost: 0, spreadCost: 0 },

    trades: [],
    position: null, // {symbol, qty, entry, entryTs, entryNotionalUsd, entryCosts}
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      volatility: 0,
      trendEdge: 0,
      decision: "WAIT",
      lastReason: "boot",
      lastTickTs: null,
    },

    config: {
      WARMUP_TICKS,
      BASE_RISK_PCT,
      MAX_RISK_PCT,
      MANUAL_RISK_PCT: null, // if set, overrides auto risk logic
      TAKE_PROFIT_PCT,
      STOP_LOSS_PCT,
      MIN_EDGE,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MAX_USD_PER_TRADE,
      MAX_TRADES_PER_DAY: MAX_TRADES_PER_DAY_DEFAULT,
      MAX_DRAWDOWN_PCT,
      MIN_USD_PER_TRADE,
      MIN_NET_TP_USD,
      TRADING_WALLET_CAP: TRADING_WALLET_CAP_DEFAULT,
      TOPUP_TRIGGER: TOPUP_TRIGGER_DEFAULT,
      TOPUP_AMOUNT: TOPUP_AMOUNT_DEFAULT,
      STATE_FILE
    },

    limits: {
      tradesToday: 0,
      dayKey: dayKey(Date.now()),
      lastTradeTs: 0,
      halted: false,
      haltReason: null
    },

    streak: { winsInRow: 0, lossesInRow: 0 },

    buf: { BTCUSDT: [], ETHUSDT: [] }
  };
}

let state = defaultState();

// ---------- PERSISTENCE ----------
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1200);
}
function saveNow() {
  try {
    ensureDirFor(STATE_FILE);
    const safe = { ...state, trades: state.trades.slice(-800), buf: state.buf };
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}
function loadNow() {
  try {
    ensureDirFor(STATE_FILE);
    if (!fs.existsSync(STATE_FILE)) return false;

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const base = defaultState();
    state = {
      ...base,
      ...parsed,
      wallets: { ...base.wallets, ...(parsed.wallets || {}) },
      realized: { ...base.realized, ...(parsed.realized || {}) },
      costs: { ...base.costs, ...(parsed.costs || {}) },
      learnStats: { ...base.learnStats, ...(parsed.learnStats || {}) },
      limits: { ...base.limits, ...(parsed.limits || {}) },
      config: { ...base.config, ...(parsed.config || {}) },
      streak: { ...base.streak, ...(parsed.streak || {}) },
      buf: { ...base.buf, ...(parsed.buf || {}) }
    };

    const dk = dayKey(Date.now());
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
    }

    state.pnl = (state.realized?.net || 0);
    return true;
  } catch {
    return false;
  }
}
loadNow();

// ---------- SIGNALS ----------
function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 60) b.shift();
}
function computeSignals(symbol) {
  const b = state.buf[symbol] || [];
  if (b.length < 10) return { vol: 0, edge: 0, conf: 0, reason: "collecting_more_data" };

  const returns = [];
  for (let i = 1; i < b.length; i++) returns.push((b[i] - b[i - 1]) / b[i - 1]);

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / state.config.WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (state.config.MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf =
    clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "warmup";
  if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS && Math.abs(edge) < state.config.MIN_EDGE) reason = "trend_unclear";
  else if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS && volNorm > 0.85) reason = "too_noisy";
  else if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS) reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

// ---------- COST MODEL ----------
function entryCostRate() {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  return state.config.FEE_RATE + spreadPct + slipPct;
}
function totalRoundTripCostRate() {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  return (2 * state.config.FEE_RATE) + spreadPct + slipPct;
}
function applyEntryCosts(usdNotional) {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  const fee = usdNotional * state.config.FEE_RATE;
  const spreadCost = usdNotional * spreadPct;
  const slippageCost = usdNotional * slipPct;

  state.costs.feePaid += fee;
  state.costs.spreadCost += spreadCost;
  state.costs.slippageCost += slippageCost;

  return fee + spreadCost + slippageCost;
}
function applyExitFee(usdNotional) {
  const fee = usdNotional * state.config.FEE_RATE;
  state.costs.feePaid += fee;
  return fee;
}

// ---------- WALLET FLOW RULES ----------
function sweepOverflowToStorehouse() {
  const cap = Number(state.config.TRADING_WALLET_CAP || 0);
  if (!cap || cap <= 0) return;

  if (state.wallets.trading > cap) {
    const overflow = state.wallets.trading - cap;
    state.wallets.trading -= overflow;
    state.wallets.storehouse += overflow;

    state.trades.push({
      time: Date.now(),
      symbol: "WALLET",
      type: "SWEEP",
      price: 0,
      qty: 0,
      usd: overflow,
      note: "overflow_to_storehouse"
    });
  }
}

function maybeTopUpFromStorehouse() {
  const trigger = Number(state.config.TOPUP_TRIGGER || 0);
  const amt = Number(state.config.TOPUP_AMOUNT || 0);
  if (!trigger || trigger <= 0) return;
  if (!amt || amt <= 0) return;

  // top-up when trading wallet falls below trigger
  if (state.wallets.trading >= trigger) return;
  if (state.wallets.storehouse <= 0) return;

  const transfer = Math.min(amt, state.wallets.storehouse);
  state.wallets.storehouse -= transfer;
  state.wallets.trading += transfer;

  state.trades.push({
    time: Date.now(),
    symbol: "WALLET",
    type: "TOPUP",
    price: 0,
    qty: 0,
    usd: transfer,
    note: "storehouse_to_trading_wallet"
  });
}

// ---------- LIMITS ----------
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}
function checkDrawdown() {
  const peak = state.startBalance;
  const dd = (peak - state.wallets.trading) / peak;
  if (dd >= state.config.MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(state.config.MAX_DRAWDOWN_PCT * 100)}%`;
  }
}
function canTradeProfitablyAtTP() {
  const rt = totalRoundTripCostRate();
  return state.config.TAKE_PROFIT_PCT > rt;
}

// ---------- RISK % LOGIC (AUTO + OWNER OVERRIDE) ----------
function currentRiskPct() {
  const manual = state.config.MANUAL_RISK_PCT;
  if (manual !== null && manual !== undefined && Number.isFinite(Number(manual))) {
    return clamp(Number(manual), 0.005, state.config.MAX_RISK_PCT);
  }

  const base = state.config.BASE_RISK_PCT;
  const max = state.config.MAX_RISK_PCT;

  // losses reduce risk quickly; wins can increase slowly
  const lossPenalty = Math.min(0.03 * state.streak.lossesInRow, base * 0.85);
  const winBoost = Math.min(0.01 * state.streak.winsInRow, max - base);

  return clamp(base - lossPenalty + winBoost, 0.005, max);
}

// ---------- TRADING ----------
function maybeEnter(symbol, price, ts) {
  const { vol, edge, conf, reason } = computeSignals(symbol);

  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  if (state.limits.halted) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = state.limits.haltReason || "halted";
    return;
  }

  if (state.position) { state.learnStats.decision = "WAIT"; return; }
  if (state.learnStats.ticksSeen < state.config.WARMUP_TICKS) { state.learnStats.decision = "WAIT"; return; }

  if (Date.now() - (state.limits.lastTradeTs || 0) < state.config.COOLDOWN_MS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "cooldown";
    return;
  }

  if (state.limits.tradesToday >= state.config.MAX_TRADES_PER_DAY) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "max_trades_today";
    return;
  }

  if (!canTradeProfitablyAtTP()) {
    state.limits.halted = true;
    state.limits.haltReason = "tp_too_small_for_fees";
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "tp_too_small_for_fees";
    return;
  }

  if (conf < 0.55) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  if (Math.abs(edge) < state.config.MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  // size by % of trading wallet
  const pct = currentRiskPct();
  let usdNotional = state.wallets.trading * pct;

  usdNotional = Math.max(usdNotional, state.config.MIN_USD_PER_TRADE);
  usdNotional = Math.min(usdNotional, state.config.MAX_USD_PER_TRADE);

  // net-at-TP must be meaningful
  const rt = totalRoundTripCostRate();
  const netPerUsdAtTP = state.config.TAKE_PROFIT_PCT - rt;
  const expectedNetAtTP = usdNotional * Math.max(0, netPerUsdAtTP);
  if (expectedNetAtTP < state.config.MIN_NET_TP_USD) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trade_too_small_for_net_tp";
    return;
  }

  // must be able to pay entry cost
  const worstEntryCosts = usdNotional * entryCostRate();
  if (state.wallets.trading <= worstEntryCosts + 1) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "wallet_too_low_for_fees";
    return;
  }

  const qty = usdNotional / price;

  const entryCosts = applyEntryCosts(usdNotional);
  state.wallets.trading -= entryCosts;

  state.position = {
    symbol,
    qty,
    entry: price,
    entryTs: ts,
    entryNotionalUsd: usdNotional,
    entryCosts
  };

  state.trades.push({
    time: ts,
    symbol,
    type: "BUY",
    price,
    qty,
    usd: usdNotional,
    cost: entryCosts,
    note: `paper_entry_${Math.round(pct * 10000) / 100}%`
  });

  state.limits.lastTradeTs = ts;
  state.limits.tradesToday += 1;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;

  // critical: prevent cross-symbol exits (the “millions/billions jump” bug)
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= state.config.TAKE_PROFIT_PCT || change <= -state.config.STOP_LOSS_PCT) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    state.wallets.trading += net;
    state.realized.net += net;
    state.pnl = state.realized.net;

    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
      state.streak.winsInRow += 1;
      state.streak.lossesInRow = 0;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net;
      state.streak.lossesInRow += 1;
      state.streak.winsInRow = 0;
    }

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price,
      qty: pos.qty,
      usd: exitNotionalUsd,
      profit: net,
      gross,
      fees: exitFee,
      note: change >= state.config.TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;

    checkDrawdown();

    // wallet flow after each completed trade
    sweepOverflowToStorehouse();
    maybeTopUpFromStorehouse();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= state.config.TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

function tick(a, b, c) {
  if (!state.running) return;

  let symbol, price, ts;
  if (typeof b === "undefined") {
    symbol = "BTCUSDT";
    price = Number(a);
    ts = Date.now();
  } else {
    symbol = String(a || "BTCUSDT");
    price = Number(b);
    ts = Number(c || Date.now());
  }

  if (!Number.isFinite(price)) return;

  checkDaily(ts);

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  maybeExit(symbol, price, ts);
  maybeEnter(symbol, price, ts);

  if (state.trades.length > 4000) state.trades = state.trades.slice(-1500);

  scheduleSave();
}

function start() {
  state.running = true;
  state.learnStats.lastReason = "started";
  scheduleSave();
}

function hardReset() {
  state = defaultState();
  saveNow();
}

function updateConfig(patch = {}) {
  state.config = { ...state.config, ...patch };

  // clamp %
  state.config.BASE_RISK_PCT = clamp(Number(state.config.BASE_RISK_PCT || 0.12), 0.005, 0.9);
  state.config.MAX_RISK_PCT = clamp(Number(state.config.MAX_RISK_PCT || 0.5), state.config.BASE_RISK_PCT, 0.95);

  // manual risk can be null or number
  if (state.config.MANUAL_RISK_PCT === "" || state.config.MANUAL_RISK_PCT === undefined) {
    state.config.MANUAL_RISK_PCT = null;
  }
  if (state.config.MANUAL_RISK_PCT !== null) {
    const v = Number(state.config.MANUAL_RISK_PCT);
    state.config.MANUAL_RISK_PCT = Number.isFinite(v) ? clamp(v, 0.005, state.config.MAX_RISK_PCT) : null;
  }

  // cap and topup
  state.config.TRADING_WALLET_CAP = Math.max(0, Number(state.config.TRADING_WALLET_CAP || TRADING_WALLET_CAP_DEFAULT));
  state.config.TOPUP_TRIGGER = Math.max(0, Number(state.config.TOPUP_TRIGGER || TOPUP_TRIGGER_DEFAULT));
  state.config.TOPUP_AMOUNT = Math.max(0, Number(state.config.TOPUP_AMOUNT || TOPUP_AMOUNT_DEFAULT));

  // trades/day
  state.config.MAX_TRADES_PER_DAY = Math.max(1, Number(state.config.MAX_TRADES_PER_DAY || MAX_TRADES_PER_DAY_DEFAULT));

  scheduleSave();
  return state.config;
}

function snapshot() {
  return {
    running: state.running,
    wallets: state.wallets,
    pnl: state.pnl,
    realized: state.realized,
    costs: state.costs,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: state.config,
    riskPctNow: currentRiskPct()
  };
}

module.exports = { start, tick, snapshot, hardReset, updateConfig };
