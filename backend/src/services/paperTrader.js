// backend/src/services/paperTrader.js
// Step B: learning paper trader (safe, deterministic starter brain)
// Compatible with old calls: tick(price)
// Also supports: tick(symbol, price, ts) and onTick(symbol, price, ts)

let state = {
  running: false,
  balance: Number(process.env.PAPER_START_BALANCE || 100000),
  pnl: 0,
  equity: Number(process.env.PAPER_START_BALANCE || 100000),
  trades: [],
  position: null, // { symbol, entryPrice, qty, openedAt, reason, stopPrice, takePrice }
  lastPrice: null,
  lastSymbol: "BTCUSDT",
  notes: [],
  learn: {
    // starter learning knobs (will be tuned later)
    minTrendEdge: 0.0006, // 0.06% MA edge required
    maxVol: 0.012,        // avoid too volatile
    minVol: 0.0012,       // avoid flat noise
    stopLossPct: 0.004,   // 0.4%
    takeProfitPct: 0.006, // 0.6%
    cooldownSec: 20,      // wait after closing
    riskPctPerTrade: 0.10,
    maxTradesPerHour: Number(process.env.PAPER_MAX_TRADES_PER_HOUR || 6)
  },
  _lastActionAt: 0,
  _tradeCountWindow: [], // timestamps
};

// In-memory price history (good enough for Step B)
const hist = {}; // symbol -> { prices: [], rets: [] }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function sma(values, n) {
  if (values.length < n) return null;
  return mean(values.slice(values.length - n));
}

function note(text) {
  state.notes = (state.notes || []).slice(-40);
  state.notes.push({ time: Date.now(), text: String(text).slice(0, 240) });
}

function start() {
  state.running = true;
  state.balance = Number(process.env.PAPER_START_BALANCE || state.balance || 100000);
  state.equity = state.balance;
  state.pnl = 0;
  state._lastActionAt = 0;
  state._tradeCountWindow = [];
  note("Paper trader started (Step B learning).");
}

function stop() {
  state.running = false;
  note("Paper trader stopped.");
}

function updateEquity(symbol, price) {
  let eq = state.balance;
  if (state.position && state.position.symbol === symbol) {
    const pos = state.position;
    const unreal = (price - pos.entryPrice) * pos.qty;
    eq += unreal;
  }
  state.equity = Number(eq.toFixed(2));
  const startBal = Number(process.env.PAPER_START_BALANCE || 100000);
  state.pnl = Number((state.equity - startBal).toFixed(2));
}

function canTradeNow(now) {
  const cooldown = state.learn.cooldownSec * 1000;
  if (now - (state._lastActionAt || 0) < cooldown) return false;

  const hourAgo = now - 60 * 60 * 1000;
  state._tradeCountWindow = (state._tradeCountWindow || []).filter(ts => ts >= hourAgo);
  if (state._tradeCountWindow.length >= state.learn.maxTradesPerHour) return false;

  return true;
}

function markTrade(now) {
  state._tradeCountWindow = (state._tradeCountWindow || []).slice(-200);
  state._tradeCountWindow.push(now);
}

function openLong(symbol, price, now, reason) {
  const riskPct = clamp(state.learn.riskPctPerTrade, 0.01, 0.5);
  const spend = state.balance * riskPct;
  const qty = spend / price;

  state.position = {
    symbol,
    entryPrice: price,
    qty,
    openedAt: now,
    reason,
    stopPrice: price * (1 - state.learn.stopLossPct),
    takePrice: price * (1 + state.learn.takeProfitPct),
  };
  state._lastActionAt = now;
  note(`OPEN LONG ${symbol} @ ${price.toFixed(2)} reason=${reason}`);
}

function closePosition(symbol, price, now, exitReason) {
  const pos = state.position;
  if (!pos || pos.symbol !== symbol) return;

  const profit = (price - pos.entryPrice) * pos.qty;
  state.balance = Number((state.balance + profit).toFixed(2));
  state.position = null;
  state._lastActionAt = now;

  const trade = {
    time: now,
    symbol,
    side: "LONG",
    entry: Number(pos.entryPrice.toFixed(2)),
    exit: Number(price.toFixed(2)),
    qty: Number(pos.qty.toFixed(8)),
    profit: Number(profit.toFixed(2)),
    durationSec: Math.max(1, Math.round((now - pos.openedAt) / 1000)),
    reason: pos.reason,
    exitReason,
  };

  state.trades = (state.trades || []).slice(-200);
  state.trades.push(trade);

  markTrade(now);
  note(`CLOSE ${symbol} @ ${price.toFixed(2)} profit=${profit.toFixed(2)} exit=${exitReason}`);
}

function decide(symbol, price, now) {
  const h = hist[symbol];
  if (!h || h.prices.length < 40) return { action: "HOLD", reason: "warming_up" };

  const maShort = sma(h.prices, 10);
  const maLong = sma(h.prices, 30);
  if (!maShort || !maLong) return { action: "HOLD", reason: "warming_up" };

  const edge = (maShort - maLong) / maLong;
  const vol = stdev(h.rets.slice(-25));

  // Avoid dumb zones
  if (vol < state.learn.minVol) return { action: "HOLD", reason: "flat_noise" };
  if (vol > state.learn.maxVol) return { action: "HOLD", reason: "too_volatile" };

  // Manage open position
  if (state.position && state.position.symbol === symbol) {
    const pos = state.position;
    if (price <= pos.stopPrice) return { action: "CLOSE", reason: "stop_loss" };
    if (price >= pos.takePrice) return { action: "CLOSE", reason: "take_profit" };
    if (edge < -state.learn.minTrendEdge * 0.6) return { action: "CLOSE", reason: "trend_flip" };
    return { action: "HOLD", reason: "manage_position" };
  }

  // Entry
  if (!canTradeNow(now)) return { action: "HOLD", reason: "cooldown_or_limit" };
  if (edge > state.learn.minTrendEdge) return { action: "OPEN_LONG", reason: "trend_confirmed" };

  return { action: "HOLD", reason: "no_signal" };
}

// Main tick (supports both signatures)
function onTick(a, b, c) {
  const now = Number(c || Date.now());

  let symbol, price;
  if (typeof a === "string") {
    symbol = a;
    price = Number(b);
  } else {
    // old mode: tick(price)
    symbol = state.lastSymbol || "BTCUSDT";
    price = Number(a);
  }

  if (!Number.isFinite(price)) return;

  state.lastSymbol = symbol;
  state.lastPrice = price;

  if (!hist[symbol]) hist[symbol] = { prices: [], rets: [] };
  const h = hist[symbol];
  const prev = h.prices.length ? h.prices[h.prices.length - 1] : null;

  h.prices.push(price);
  if (prev) h.rets.push((price - prev) / prev);

  h.prices = h.prices.slice(-240);
  h.rets = h.rets.slice(-240);

  updateEquity(symbol, price);

  if (!state.running) return;

  const d = decide(symbol, price, now);
  if (d.action === "OPEN_LONG") openLong(symbol, price, now, d.reason);
  if (d.action === "CLOSE") closePosition(symbol, price, now, d.reason);
}

// Keep your old API name
function tick(priceOrSymbol, maybePrice, maybeTs) {
  return onTick(priceOrSymbol, maybePrice, maybeTs);
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    equity: state.equity,
    pnl: state.pnl,
    trades: (state.trades || []).slice(-25),
    position: state.position,
    lastPrice: state.lastPrice,
    symbol: state.lastSymbol,
    learn: state.learn,
    notes: (state.notes || []).slice(-10),
  };
}

module.exports = { start, stop, tick, onTick, snapshot };
