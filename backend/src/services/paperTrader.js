// backend/src/services/paperTrader.js
// Step C: learning + controlled paper trading (SAFE defaults)

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

// How fast it starts trading (warmup)
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200); // lower = trades sooner

// Risk / sizing
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01); // 1% of balance per trade
const MAX_POSITION_USD = Number(process.env.PAPER_MAX_POSITION_USD || 2000); // cap exposure

// Strategy thresholds (edge)
const MIN_TREND_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0008); // ~0.08%
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TAKE_PROFIT_PCT || 0.003); // 0.30%
const STOP_LOSS_PCT = Number(process.env.PAPER_STOP_LOSS_PCT || 0.002); // 0.20%

// Safety: throttle trading
const MIN_SECONDS_BETWEEN_TRADES = Number(process.env.PAPER_MIN_SECONDS_BETWEEN_TRADES || 25);

// Optional: pause paper trading on Sabbath window (simple switch)
const SABBATH_PAUSE = String(process.env.SABBATH_PAUSE || "false").toLowerCase() === "true";

// --- state ---
let state = {
  running: false,
  balance: START_BAL,
  pnl: 0,

  // learning stats
  learnStats: {
    ticksSeen: 0,
    confidence: 0,        // 0..1
    volatility: 0,        // 0..1 (scaled)
    lastReason: "starting",
    lastDecision: "HOLD",
    lastUpdated: null,
  },

  // price tracking
  lastPrice: null,
  lastTs: null,

  // EMA trend
  emaFast: null,
  emaSlow: null,

  // volatility tracking
  prevPrice: null,
  volEma: 0,

  // position / trades
  position: null, // { side:'LONG', entry, qty, entryTs, tp, sl }
  trades: [],

  // safety timing
  lastTradeTs: 0,
};

// --- helpers ---
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function nowMs(tsMaybe) {
  const t = Number(tsMaybe);
  return Number.isFinite(t) ? t : Date.now();
}

function isSabbath(ms) {
  // Simple placeholder: if you enable SABBATH_PAUSE, we pause trading always
  // (we can upgrade to true Friday-sundown logic by location later)
  return SABBATH_PAUSE;
}

function ema(prev, value, alpha) {
  if (prev == null) return value;
  return prev + alpha * (value - prev);
}

function pushTrade(t) {
  state.trades.push(t);
  if (state.trades.length > 200) state.trades.shift();
}

function updateLearn(reason, decision) {
  state.learnStats.lastReason = reason;
  state.learnStats.lastDecision = decision;
  state.learnStats.lastUpdated = new Date().toISOString();
}

// --- public ---
function start() {
  state.running = true;
  state.balance = Number(process.env.PAPER_START_BALANCE || state.balance || START_BAL);
  updateLearn("paper trader started", "HOLD");
}

function tick(symbol, price, ts) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;

  const ms = nowMs(ts);
  state.lastPrice = p;
  state.lastTs = ms;

  // --- learning counters ---
  state.learnStats.ticksSeen += 1;

  // EMA trend (fast/slow)
  // Fast reacts quicker, slow smoother
  state.emaFast = ema(state.emaFast, p, 0.18);
  state.emaSlow = ema(state.emaSlow, p, 0.06);

  // Volatility estimate (EMA of absolute returns)
  if (state.prevPrice != null) {
    const ret = Math.abs((p - state.prevPrice) / state.prevPrice);
    state.volEma = ema(state.volEma, ret, 0.12);
  }
  state.prevPrice = p;

  // Convert to a nice 0..1-ish number (scaled)
  const volScaled = clamp(state.volEma * 120, 0, 1);
  state.learnStats.volatility = volScaled;

  // Confidence builds over time, but drops if volatility is extreme
  const warm = clamp(state.learnStats.ticksSeen / Math.max(1, WARMUP_TICKS), 0, 1);
  const volPenalty = clamp(volScaled * 0.55, 0, 0.55);
  state.learnStats.confidence = clamp(0.15 + warm * 0.85 - volPenalty, 0, 1);

  // --- Decision engine (paper trades) ---
  if (!state.running) {
    updateLearn("not running", "HOLD");
    return;
  }

  if (isSabbath(ms)) {
    updateLearn("paused (Sabbath pause enabled)", "HOLD");
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    updateLearn(`warming up (${state.learnStats.ticksSeen}/${WARMUP_TICKS})`, "HOLD");
    return;
  }

  // throttle trade frequency
  if (ms - state.lastTradeTs < MIN_SECONDS_BETWEEN_TRADES * 1000) {
    updateLearn("cooldown active (prevent spam trades)", "HOLD");
    return;
  }

  // Need EMAs initialized
  if (state.emaFast == null || state.emaSlow == null) {
    updateLearn("ema not ready", "HOLD");
    return;
  }

  const edge = (state.emaFast - state.emaSlow) / state.emaSlow; // trend edge
  const edgeAbs = Math.abs(edge);

  // If volatility is too crazy, just watch
  if (state.learnStats.volatility > 0.92) {
    updateLearn("volatility too high — waiting", "HOLD");
    return;
  }

  // If no clear trend edge, wait
  if (edgeAbs < MIN_TREND_EDGE) {
    updateLearn(`flat/no edge (${(edgeAbs * 100).toFixed(3)}%)`, "HOLD");
    return;
  }

  // --- manage existing position ---
  if (state.position) {
    const pos = state.position;
    const pnlUsd = (p - pos.entry) * pos.qty;
    const pnlPct = (p - pos.entry) / pos.entry;

    // exits
    if (pnlPct >= TAKE_PROFIT_PCT) {
      // take profit
      state.balance += pnlUsd;
      state.pnl += pnlUsd;
      pushTrade({
        time: ms,
        symbol: symbol || "BTCUSDT",
        type: "SELL (TP)",
        price: p,
        qty: pos.qty,
        profit: pnlUsd,
        note: `take profit ${Math.round(TAKE_PROFIT_PCT * 10000) / 100}%`,
      });
      state.position = null;
      state.lastTradeTs = ms;
      updateLearn("took profit", "SELL");
      return;
    }

    if (pnlPct <= -STOP_LOSS_PCT) {
      // stop loss
      state.balance += pnlUsd;
      state.pnl += pnlUsd;
      pushTrade({
        time: ms,
        symbol: symbol || "BTCUSDT",
        type: "SELL (SL)",
        price: p,
        qty: pos.qty,
        profit: pnlUsd,
        note: `stop loss ${Math.round(STOP_LOSS_PCT * 10000) / 100}%`,
      });
      state.position = null;
      state.lastTradeTs = ms;
      updateLearn("stopped out", "SELL");
      return;
    }

    // If trend flips hard against position, exit early
    if (edge < -MIN_TREND_EDGE * 1.2) {
      state.balance += pnlUsd;
      state.pnl += pnlUsd;
      pushTrade({
        time: ms,
        symbol: symbol || "BTCUSDT",
        type: "SELL (TrendFlip)",
        price: p,
        qty: pos.qty,
        profit: pnlUsd,
        note: "trend flipped against position",
      });
      state.position = null;
      state.lastTradeTs = ms;
      updateLearn("exited on trend flip", "SELL");
      return;
    }

    updateLearn("holding position (monitoring TP/SL)", "HOLD");
    return;
  }

  // --- open a new position (LONG only for now, safe & simple) ---
  if (edge > MIN_TREND_EDGE) {
    const usdToUse = Math.min(state.balance * RISK_PCT, MAX_POSITION_USD);
    if (usdToUse < 10) {
      updateLearn("balance too low to open position", "HOLD");
      return;
    }

    const qty = usdToUse / p;

    state.position = {
      side: "LONG",
      entry: p,
      qty,
      entryTs: ms,
    };

    pushTrade({
      time: ms,
      symbol: symbol || "BTCUSDT",
      type: "BUY",
      price: p,
      qty,
      profit: 0,
      note: `edge ${(edge * 100).toFixed(3)}% • conf ${(state.learnStats.confidence * 100).toFixed(0)}%`,
    });

    state.lastTradeTs = ms;
    updateLearn(`entered LONG (edge ${(edge * 100).toFixed(3)}%)`, "BUY");
    return;
  }

  updateLearn("no entry rule matched", "HOLD");
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades,
    position: state.position,
    lastPrice: state.lastPrice,
    learnStats: {
      ticksSeen: state.learnStats.ticksSeen,
      confidence: state.learnStats.confidence,
      volatility: state.learnStats.volatility,
      lastReason: state.learnStats.lastReason,
      lastDecision: state.learnStats.lastDecision,
      lastUpdated: state.learnStats.lastUpdated,
    },
  };
}

module.exports = { start, tick, snapshot };
