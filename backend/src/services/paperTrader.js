// backend/src/services/paperTrader.js
// Paper trading engine + visible learning stats (confidence, ticks, decision reason)
// ✅ Upgraded: caps, daily trade limits, safer sizing, prevents runaway balance

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function getConfig() {
  return {
    START_BAL: num(process.env.PAPER_START_BALANCE, 100000),

    // learning
    WARMUP_TICKS: num(process.env.PAPER_WARMUP_TICKS, 200),

    // risk + sizing
    RISK_PCT: num(process.env.PAPER_RISK_PCT, 0.01),          // 1% of balance per trade (risk budget)
    TAKE_PROFIT_PCT: num(process.env.PAPER_TP_PCT, 0.004),     // 0.4%
    STOP_LOSS_PCT: num(process.env.PAPER_SL_PCT, 0.003),       // 0.3%
    MIN_EDGE: num(process.env.PAPER_MIN_TREND_EDGE, 0.0007),   // 0.07%

    // ✅ safety caps (IMPORTANT)
    MAX_USD_PER_TRADE: num(process.env.PAPER_MAX_USD_PER_TRADE, 300), // <= $300 notional per trade
    MAX_TRADES_PER_DAY: num(process.env.PAPER_MAX_TRADES_PER_DAY, 40),// <= 40/day
  };
}

let state = {
  running: false,
  balance: getConfig().START_BAL,
  pnl: 0,
  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, time, notional}

  lastPriceBySymbol: {},

  learnStats: {
    ticksSeen: 0,
    confidence: 0,         // 0..1
    volatility: 0,         // normalized
    trendEdge: 0,          // relative change
    decision: "WAIT",      // WAIT | BUY | SELL
    lastReason: "not_started",
    lastTickTs: null,

    // ✅ new: limits + counters
    tradesToday: 0,
    tradesTodayLimit: getConfig().MAX_TRADES_PER_DAY,
    maxUsdPerTrade: getConfig().MAX_USD_PER_TRADE,
    dayKey: null
  },

  // rolling price buffer per symbol
  buf: {
    BTCUSDT: [],
    ETHUSDT: []
  }
};

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function resetDailyCounters(ts) {
  const k = dayKey(ts);
  if (state.learnStats.dayKey !== k) {
    state.learnStats.dayKey = k;
    state.learnStats.tradesToday = 0;
  }
}

function resetMoney() {
  const cfg = getConfig();
  state.balance = cfg.START_BAL;
  state.pnl = 0;
  state.trades = [];
  state.position = null;
}

function start() {
  const cfg = getConfig();
  state.running = true;

  resetMoney();

  state.learnStats.ticksSeen = 0;
  state.learnStats.confidence = 0;
  state.learnStats.volatility = 0;
  state.learnStats.trendEdge = 0;
  state.learnStats.decision = "WAIT";
  state.learnStats.lastReason = "started";
  state.learnStats.lastTickTs = null;

  state.learnStats.tradesToday = 0;
  state.learnStats.tradesTodayLimit = cfg.MAX_TRADES_PER_DAY;
  state.learnStats.maxUsdPerTrade = cfg.MAX_USD_PER_TRADE;
  state.learnStats.dayKey = null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}

function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 60) b.shift();
}

function computeSignals(symbol) {
  const cfg = getConfig();
  const b = state.buf[symbol] || [];

  if (b.length < 10) {
    return { vol: 0, edge: 0, conf: 0, reason: "collecting_more_data" };
  }

  const returns = [];
  for (let i = 1; i < b.length; i++) {
    const prev = b[i - 1] || 1;
    const r = (b[i] - prev) / prev;
    returns.push(r);
  }

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / cfg.WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (cfg.MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "waiting_warmup";
  if (state.learnStats.ticksSeen < cfg.WARMUP_TICKS) reason = "learning_warmup";
  else if (Math.abs(edge) < cfg.MIN_EDGE) reason = "trend_unclear";
  else if (volNorm > 0.85) reason = "too_noisy";
  else reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

function canTradeNow(ts) {
  const cfg = getConfig();
  resetDailyCounters(ts);

  state.learnStats.tradesTodayLimit = cfg.MAX_TRADES_PER_DAY;
  state.learnStats.maxUsdPerTrade = cfg.MAX_USD_PER_TRADE;

  if (state.learnStats.tradesToday >= cfg.MAX_TRADES_PER_DAY) {
    state.learnStats.lastReason = "daily_trade_limit_reached";
    return false;
  }
  return true;
}

function sizeQty(price) {
  const cfg = getConfig();

  // risk dollars is budget, but NOTIONAL cap is the real “how much you buy”
  const riskDollars = state.balance * cfg.RISK_PCT;

  // ✅ notional = what you actually put in the market (cap it hard)
  const notional = clamp(
    Math.min(riskDollars, cfg.MAX_USD_PER_TRADE),
    1,
    cfg.MAX_USD_PER_TRADE
  );

  // qty based on notional (safer; prevents runaway billions)
  const qty = notional / price;

  return { qty: Math.max(qty, 0.00000001), notional };
}

function maybeEnter(symbol, price, ts) {
  const cfg = getConfig();
  const { vol, edge, conf, reason } = computeSignals(symbol);

  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  if (state.position) {
    state.learnStats.decision = "WAIT";
    return;
  }

  if (state.learnStats.ticksSeen < cfg.WARMUP_TICKS) {
    state.learnStats.decision = "WAIT";
    return;
  }

  if (!canTradeNow(ts)) {
    state.learnStats.decision = "WAIT";
    return;
  }

  if (conf < 0.45) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  if (Math.abs(edge) < cfg.MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  // ✅ Enter LONG baseline
  const { qty, notional } = sizeQty(price);

  state.position = { symbol, side: "LONG", qty, entry: price, time: ts, notional };

  state.trades.push({ time: ts, symbol, type: "BUY", price, qty, note: "paper_entry", notional });

  state.learnStats.tradesToday += 1;
  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(price, ts) {
  const cfg = getConfig();
  const pos = state.position;
  if (!pos) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= cfg.TAKE_PROFIT_PCT || change <= -cfg.STOP_LOSS_PCT) {
    const profit = (price - entry) * pos.qty;

    // ✅ balance changes only by P/L (paper), no runaway multipliers
    state.balance += profit;
    state.pnl += profit;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price,
      qty: pos.qty,
      profit,
      note: change >= cfg.TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;
    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= cfg.TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

// ✅ tick supports BOTH signatures:
// tick(price)                 (legacy)
// tick(symbol, price, ts)     (new)
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

  if (!Number.isFinite(price) || price <= 0) return;

  resetDailyCounters(ts);

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  // manage open position first
  maybeExit(price, ts);

  // then consider entry
  maybeEnter(symbol, price, ts);
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPrice: state.lastPriceBySymbol.BTCUSDT ?? null,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats
  };
}

module.exports = { start, tick, snapshot };
