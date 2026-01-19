// backend/src/services/paperTrader.js
// Stage B: Realistic friction (fees, slippage, spread, cooldown, max trades/day, max USD/trade, drawdown stop)

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

// Risk + exits
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// Friction realism
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);              // 0.26%
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);             // 8 bps = 0.08%
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);                 // 6 bps = 0.06%
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12_000);        // 12s
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25); // 25% stop

let state = {
  running: false,
  startBalance: START_BAL,
  balance: START_BAL,
  equityHigh: START_BAL,
  pnl: 0,

  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, entryTs, entryFee}

  lastPriceBySymbol: {},
  buf: { BTCUSDT: [], ETHUSDT: [] },

  limits: {
    tradesToday: 0,
    dayKey: null,
    lastTradeTs: 0,
    halted: false,
    haltReason: null
  },

  learnStats: {
    ticksSeen: 0,
    confidence: 0,
    volatility: 0,
    trendEdge: 0,
    decision: "WAIT",
    lastReason: "not_started",
    lastTickTs: null,
    // friction stats:
    feePaid: 0,
    slippageCost: 0,
    spreadCost: 0
  }
};

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}

function dayKey(ts) {
  // UTC date key
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function ensureDaily(ts) {
  const k = dayKey(ts);
  if (state.limits.dayKey !== k) {
    state.limits.dayKey = k;
    state.limits.tradesToday = 0;
    state.limits.halted = false;
    state.limits.haltReason = null;
  }
}

function resetMoney() {
  state.startBalance = Number(process.env.PAPER_START_BALANCE || START_BAL);
  state.balance = state.startBalance;
  state.equityHigh = state.startBalance;
  state.pnl = 0;
  state.trades = [];
  state.position = null;

  state.limits.tradesToday = 0;
  state.limits.lastTradeTs = 0;
  state.limits.halted = false;
  state.limits.haltReason = null;

  state.learnStats.feePaid = 0;
  state.learnStats.slippageCost = 0;
  state.learnStats.spreadCost = 0;
}

function start() {
  state.running = true;
  resetMoney();

  state.learnStats.ticksSeen = 0;
  state.learnStats.confidence = 0;
  state.learnStats.volatility = 0;
  state.learnStats.trendEdge = 0;
  state.learnStats.decision = "WAIT";
  state.learnStats.lastReason = "started";
  state.learnStats.lastTickTs = null;
}

function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 80) b.shift();
}

function computeSignals(symbol) {
  const b = state.buf[symbol] || [];
  if (b.length < 12) return { vol: 0, edge: 0, conf: 0, reason: "collecting_more_data" };

  const returns = [];
  for (let i = 1; i < b.length; i++) returns.push((b[i] - b[i - 1]) / b[i - 1]);

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late  = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.75;

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.15, 1);

  let reason = "waiting_warmup";
  if (state.learnStats.ticksSeen < WARMUP_TICKS) reason = "learning_warmup";
  else if (Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (volNorm > 0.9) reason = "too_noisy";
  else reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

function midToFillPrice(mid, side) {
  // Spread: buy pays ask, sell hits bid
  const spread = (SPREAD_BP / 10_000);
  const slip = (SLIPPAGE_BP / 10_000);

  const sign = side === "BUY" ? +1 : -1;
  const spreadMove = mid * spread * sign;
  const slipMove = mid * slip * sign;

  // total worse fill
  return mid + spreadMove + slipMove;
}

function applyFee(notionalUsd) {
  const fee = Math.max(0, notionalUsd * FEE_RATE);
  state.learnStats.feePaid += fee;
  return fee;
}

function updateEquityHigh() {
  if (state.balance > state.equityHigh) state.equityHigh = state.balance;
}

function checkDrawdownStop() {
  const dd = (state.equityHigh - state.balance) / (state.equityHigh || 1);
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_hit_${Math.round(dd*100)}%`;
  }
}

function canTradeNow(ts) {
  if (state.limits.halted) return { ok: false, reason: state.limits.haltReason || "halted" };
  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) return { ok: false, reason: "max_trades_per_day" };
  if (ts - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  return { ok: true, reason: "ok" };
}

function enterLong(symbol, mid, ts, conf, edge, reason) {
  const gate = canTradeNow(ts);
  if (!gate.ok) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = gate.reason;
    return;
  }

  // position sizing: cap by MAX_USD_PER_TRADE
  const riskDollars = state.balance * RISK_PCT;
  const usdToUse = clamp(riskDollars, 10, MAX_USD_PER_TRADE);
  const fill = midToFillPrice(mid, "BUY");
  const qty = Math.max(0.0000001, usdToUse / fill);
  const notional = qty * fill;

  const fee = applyFee(notional);
  state.balance -= fee; // pay fee on entry

  // account friction costs (spread + slippage) just for visibility
  const spreadCost = qty * (mid * (SPREAD_BP / 10_000));
  const slipCost = qty * (mid * (SLIPPAGE_BP / 10_000));
  state.learnStats.spreadCost += spreadCost;
  state.learnStats.slippageCost += slipCost;

  state.position = { symbol, side: "LONG", qty, entry: fill, entryTs: ts, entryFee: fee };

  state.trades.push({
    time: ts,
    symbol,
    type: "BUY",
    price: fill,
    qty,
    fee,
    confidence: conf,
    trendEdge: edge,
    note: `entry:${reason}`
  });

  state.limits.tradesToday += 1;
  state.limits.lastTradeTs = ts;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(mid, ts) {
  const pos = state.position;
  if (!pos) return;

  const fillSell = midToFillPrice(mid, "SELL"); // worse sell
  const entry = pos.entry;
  const change = (fillSell - entry) / entry;

  if (change >= TAKE_PROFIT_PCT || change <= -STOP_LOSS_PCT) {
    const gross = (fillSell - entry) * pos.qty;
    const notional = pos.qty * fillSell;
    const fee = applyFee(notional);

    const net = gross - fee;
    state.balance += net;
    state.pnl += net;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price: fillSell,
      qty: pos.qty,
      fee,
      profit: net,
      note: change >= TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;

    updateEquityHigh();
    checkDrawdownStop();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

// tick(symbol, price, ts) OR legacy tick(price)
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

  ensureDaily(ts);

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  // Signals (always updated)
  const { vol, edge, conf, reason } = computeSignals(symbol);
  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  // Risk mgmt first
  maybeExit(price, ts);

  // Entry
  if (!state.position) {
    if (state.learnStats.ticksSeen < WARMUP_TICKS) {
      state.learnStats.decision = "WAIT";
      state.learnStats.lastReason = "warmup";
      return;
    }
    if (conf < 0.55) {
      state.learnStats.decision = "WAIT";
      state.learnStats.lastReason = "confidence_low";
      return;
    }
    if (Math.abs(edge) < MIN_EDGE) {
      state.learnStats.decision = "WAIT";
      state.learnStats.lastReason = "trend_below_threshold";
      return;
    }
    if (state.limits.halted) {
      state.learnStats.decision = "WAIT";
      state.learnStats.lastReason = state.limits.haltReason || "halted";
      return;
    }
    // Stage B: LONG-only baseline
    enterLong(symbol, price, ts, conf, edge, reason);
  }
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: {
      START_BAL,
      WARMUP_TICKS,
      RISK_PCT,
      TAKE_PROFIT_PCT,
      STOP_LOSS_PCT,
      MIN_EDGE,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MAX_USD_PER_TRADE,
      MAX_TRADES_PER_DAY,
      MAX_DRAWDOWN_PCT
    }
  };
}

module.exports = { start, tick, snapshot };
