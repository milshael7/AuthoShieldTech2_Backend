// backend/src/trading/paperTrader.js
// --------------------------------------------------
// AutoShield — Paper Trading Engine (TENANT SAFE v2)
// --------------------------------------------------
// ✅ Admin + Manager only (enforced at routes)
// ✅ Deterministic in-memory market sim (no external deps)
// ✅ Multi-tenant isolation
// ✅ Candle generation (OHLC)
// ✅ Equity mark-to-market
// ✅ Safe for demo + audits
// --------------------------------------------------

const { audit } = require("../lib/audit");

/* ===================== CONFIG ===================== */

const CONFIG = {
  startingBalance: 100000,       // USD
  maxRiskPct: 0.02,              // 2% risk per trade policy (enforced lightly here)
  maxOpenPositions: 5,
  defaultSymbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  tickMs: 1000,                  // market tick every 1s
  candleMs: 60 * 1000,           // 1m candles
  maxCandles: 2000,              // cap memory
  slippageBps: 2,                // 0.02% slippage
};

/* ===================== STATE ===================== */

// tenantId -> state
const tenants = new Map();

/* ===================== HELPERS ===================== */

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Deterministic-ish pseudo random (seeded by tenant+symbol)
function xorshift32(seed) {
  let x = seed | 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function seedFrom(tenantId, symbol) {
  const s = `${tenantId}:${symbol}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getTenantState(tenantId) {
  if (!tenantId) throw new Error("Missing tenantId");

  if (!tenants.has(tenantId)) {
    const initial = {
      paused: false,
      balance: CONFIG.startingBalance,
      equity: CONFIG.startingBalance,

      orders: [],
      positions: [],
      history: [],

      stats: { wins: 0, losses: 0, trades: 0 },

      market: {
        // symbol -> { price, rnd }
        prices: {},
        // symbol -> candles array [{t, o,h,l,c}]
        candles: {},
        lastTickAt: Date.now(),
        lastCandleAt: Date.now(),
      },
    };

    // init market
    for (const sym of CONFIG.defaultSymbols) {
      const rnd = xorshift32(seedFrom(tenantId, sym));
      const base =
        sym === "BTCUSDT" ? 65000 :
        sym === "ETHUSDT" ? 3500 :
        sym === "SOLUSDT" ? 150 :
        sym === "XRPUSDT" ? 0.6 : 100;

      initial.market.prices[sym] = { price: base, rnd };
      initial.market.candles[sym] = [];
      // seed first candle
      seedCandle(initial.market.candles[sym], base);
    }

    tenants.set(tenantId, initial);
  }

  return tenants.get(tenantId);
}

function seedCandle(arr, price) {
  const t = Date.now() - CONFIG.candleMs;
  arr.push({ t, o: price, h: price, l: price, c: price });
}

function currentCandle(arr) {
  if (!arr.length) return null;
  return arr[arr.length - 1];
}

function maybeRollCandle(arr, price) {
  const t = Date.now();
  const last = currentCandle(arr);
  if (!last) {
    arr.push({ t, o: price, h: price, l: price, c: price });
    return;
  }

  // if candle window passed, start a new candle
  if (t - last.t >= CONFIG.candleMs) {
    arr.push({ t, o: last.c, h: last.c, l: last.c, c: last.c });
    if (arr.length > CONFIG.maxCandles) {
      arr.splice(0, arr.length - CONFIG.maxCandles);
    }
  }
}

function updateCandle(arr, price) {
  const c = currentCandle(arr);
  if (!c) return;
  c.h = Math.max(c.h, price);
  c.l = Math.min(c.l, price);
  c.c = price;
}

function calcPnL(pos, price) {
  const diff =
    pos.side === "BUY"
      ? price - pos.entryPrice
      : pos.entryPrice - price;
  return diff * pos.qty;
}

function recalcEquity(state) {
  let unrealized = 0;

  for (const p of state.positions) {
    const mp = state.market.prices[p.symbol]?.price;
    if (mp) unrealized += calcPnL(p, mp);
  }

  state.equity = state.balance + unrealized;
  state.unrealizedPnL = unrealized;
}

/* ===================== MARKET TICK ===================== */

function marketTick(tenantId) {
  const st = getTenantState(tenantId);
  if (st.paused) return;

  for (const sym of Object.keys(st.market.prices)) {
    const node = st.market.prices[sym];
    const rnd = node.rnd();

    // gentle random walk with symbol-specific volatility
    const vol =
      sym === "BTCUSDT" ? 0.0025 :
      sym === "ETHUSDT" ? 0.0035 :
      sym === "SOLUSDT" ? 0.006 :
      sym === "XRPUSDT" ? 0.01 : 0.004;

    const drift = (rnd - 0.5) * 2 * vol;
    const next = clamp(node.price * (1 + drift), 0.0001, 999999999);
    node.price = Number(next.toFixed(8));

    const candles = st.market.candles[sym];
    maybeRollCandle(candles, node.price);
    updateCandle(candles, node.price);
  }

  recalcEquity(st);
}

/* ===================== CONTROL LOOP ===================== */

// single interval to tick all tenants
setInterval(() => {
  for (const tenantId of tenants.keys()) {
    try {
      marketTick(tenantId);
    } catch {}
  }
}, CONFIG.tickMs);

/* ===================== CORE ENGINE ===================== */

function placeOrder(tenantId, { actorId, symbol, side, qty, price }) {
  const st = getTenantState(tenantId);

  if (st.paused) throw new Error("Trading is paused");
  if (st.positions.length >= CONFIG.maxOpenPositions)
    throw new Error("Max open positions reached");

  symbol = String(symbol || "").trim().toUpperCase();
  side = String(side || "").trim().toUpperCase();
  qty = toNum(qty);

  if (!symbol) throw new Error("Missing symbol");
  if (!["BUY", "SELL"].includes(side)) throw new Error("Invalid side");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Invalid qty");

  const mp = st.market.prices[symbol]?.price;
  const px = Number((toNum(price, mp || 0) || mp || 0).toFixed(8));
  if (!px || px <= 0) throw new Error("Invalid price");

  // light risk policy: block if balance too low
  const riskBudget = st.balance * CONFIG.maxRiskPct;
  if (riskBudget <= 0) throw new Error("Insufficient balance");

  const slip = px * (CONFIG.slippageBps / 10000);
  const fillPrice = side === "BUY" ? px + slip : px - slip;

  const order = {
    id: uid("ORD"),
    symbol,
    side,
    qty,
    price: fillPrice,
    status: "FILLED",
    createdAt: nowISO(),
  };

  const position = {
    id: uid("POS"),
    symbol,
    side,
    qty,
    entryPrice: fillPrice,
    openedAt: nowISO(),
  };

  st.orders.push(order);
  st.positions.push(position);
  st.stats.trades += 1;

  audit({
    actorId,
    action: "PAPER_ORDER_FILLED",
    targetType: "Position",
    targetId: position.id,
    companyId: tenantId,
    metadata: { symbol, side, qty, price: fillPrice },
  });

  recalcEquity(st);
  return position;
}

function closePosition(tenantId, actorId, positionId, exitPrice) {
  const st = getTenantState(tenantId);

  const idx = st.positions.findIndex((p) => p.id === positionId);
  if (idx === -1) throw new Error("Position not found");

  const pos = st.positions[idx];
  const mp = st.market.prices[pos.symbol]?.price;
  const px = Number((toNum(exitPrice, mp || 0) || mp || 0).toFixed(8));
  if (!px || px <= 0) throw new Error("Invalid exit price");

  const pnl = calcPnL(pos, px);

  st.balance += pnl;
  st.positions.splice(idx, 1);

  st.history.push({
    ...pos,
    exitPrice: px,
    pnl,
    closedAt: nowISO(),
  });

  if (pnl >= 0) st.stats.wins += 1;
  else st.stats.losses += 1;

  audit({
    actorId,
    action: "PAPER_POSITION_CLOSED",
    targetType: "Position",
    targetId: pos.id,
    companyId: tenantId,
    metadata: { pnl, exitPrice: px },
  });

  recalcEquity(st);
  return pnl;
}

/* ===================== CONTROL ===================== */

function pause(tenantId, actorId) {
  const st = getTenantState(tenantId);
  st.paused = true;

  audit({
    actorId,
    action: "PAPER_TRADING_PAUSED",
    targetType: "Trading",
    targetId: "PAPER",
    companyId: tenantId,
  });
}

function resume(tenantId, actorId) {
  const st = getTenantState(tenantId);
  st.paused = false;

  audit({
    actorId,
    action: "PAPER_TRADING_RESUMED",
    targetType: "Trading",
    targetId: "PAPER",
    companyId: tenantId,
  });
}

function hardReset(tenantId, actorId = "system") {
  // delete tenant state so it recreates clean
  tenants.delete(tenantId);

  audit({
    actorId,
    action: "PAPER_TRADING_RESET",
    targetType: "Trading",
    targetId: "PAPER",
    companyId: tenantId,
  });

  // recreate immediately so snapshots work after reset
  getTenantState(tenantId);
}

/* ===================== SNAPSHOT + CANDLES ===================== */

function snapshot(tenantId) {
  const st = getTenantState(tenantId);
  recalcEquity(st);

  return {
    paused: st.paused,
    balance: Number(st.balance.toFixed(2)),
    equity: Number(st.equity.toFixed(2)),
    unrealizedPnL: Number((st.unrealizedPnL || 0).toFixed(2)),
    openPositions: st.positions.length,
    positions: st.positions,
    stats: st.stats,
    performance: {
      wins: st.stats.wins,
      losses: st.stats.losses,
      trades: st.stats.trades,
    },
    adaptive: {
      maxOpenPositions: CONFIG.maxOpenPositions,
      maxRiskPct: CONFIG.maxRiskPct,
    },
  };
}

function getCandles(tenantId, symbol, limit = 200) {
  const st = getTenantState(tenantId);
  symbol = String(symbol || "").trim().toUpperCase();
  const arr = st.market.candles[symbol] || [];
  const n = clamp(Number(limit) || 200, 1, 2000);

  // return in ascending time order
  return arr.slice(-n).map(c => ({
    time: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c
  }));
}

function getMarketPrice(tenantId, symbol) {
  const st = getTenantState(tenantId);
  symbol = String(symbol || "").trim().toUpperCase();
  return st.market.prices[symbol]?.price || null;
}

/* ===================== EXPORT ===================== */

module.exports = {
  // engine
  placeOrder,
  closePosition,

  // control
  pause,
  resume,
  hardReset,

  // read
  snapshot,
  getCandles,
  getMarketPrice,
};
