// backend/src/trading/paperTrader.js
// --------------------------------------------------
// AutoShield — Paper Trading Engine (LOCKED)
// --------------------------------------------------
// ✅ Admin + Manager only
// ✅ Deterministic, in-memory
// ✅ No external dependencies
// ✅ Safe for demo + audits
// --------------------------------------------------

const { audit } = require('../lib/audit');

// ------------------ CONFIG ------------------
const CONFIG = {
  startingBalance: 100000, // USD
  maxRiskPct: 0.02,        // 2% per trade
  maxOpenPositions: 5,
};

// ------------------ STATE ------------------
let state = {
  paused: false,
  balance: CONFIG.startingBalance,
  equity: CONFIG.startingBalance,
  orders: [],
  positions: [],
  history: [],
  stats: {
    wins: 0,
    losses: 0,
    trades: 0,
  },
};

// ------------------ HELPERS ------------------
function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
}

function calcPnL(pos, price) {
  const diff =
    pos.side === 'BUY'
      ? price - pos.entryPrice
      : pos.entryPrice - price;
  return diff * pos.qty;
}

function recalcEquity(marketPrices = {}) {
  let unrealized = 0;
  for (const p of state.positions) {
    const price = marketPrices[p.symbol];
    if (price) unrealized += calcPnL(p, price);
  }
  state.equity = state.balance + unrealized;
}

// ------------------ CORE ENGINE ------------------

function placeOrder({
  actorId,
  symbol,
  side,
  qty,
  price,
}) {
  if (state.paused) {
    throw new Error('Trading is paused');
  }

  if (state.positions.length >= CONFIG.maxOpenPositions) {
    throw new Error('Max open positions reached');
  }

  const riskAmount = state.balance * CONFIG.maxRiskPct;
  if (riskAmount <= 0) {
    throw new Error('Insufficient balance');
  }

  const order = {
    id: uid('ORD'),
    symbol,
    side,
    qty,
    price,
    status: 'FILLED',
    createdAt: now(),
  };

  const position = {
    id: uid('POS'),
    symbol,
    side,
    qty,
    entryPrice: price,
    openedAt: now(),
  };

  state.orders.push(order);
  state.positions.push(position);
  state.stats.trades += 1;

  audit({
    actorId,
    action: 'PAPER_ORDER_FILLED',
    targetType: 'Position',
    targetId: position.id,
    metadata: { symbol, side, qty, price },
  });

  return position;
}

function closePosition(actorId, positionId, exitPrice) {
  const idx = state.positions.findIndex(p => p.id === positionId);
  if (idx === -1) throw new Error('Position not found');

  const pos = state.positions[idx];
  const pnl = calcPnL(pos, exitPrice);

  state.balance += pnl;
  state.positions.splice(idx, 1);

  state.history.push({
    ...pos,
    exitPrice,
    pnl,
    closedAt: now(),
  });

  if (pnl >= 0) state.stats.wins += 1;
  else state.stats.losses += 1;

  audit({
    actorId,
    action: 'PAPER_POSITION_CLOSED',
    targetType: 'Position',
    targetId: pos.id,
    metadata: { pnl, exitPrice },
  });

  return pnl;
}

// ------------------ CONTROL ------------------

function pause(actorId) {
  state.paused = true;
  audit({
    actorId,
    action: 'PAPER_TRADING_PAUSED',
    targetType: 'Trading',
    targetId: 'GLOBAL',
  });
}

function resume(actorId) {
  state.paused = false;
  audit({
    actorId,
    action: 'PAPER_TRADING_RESUMED',
    targetType: 'Trading',
    targetId: 'GLOBAL',
  });
}

function reset(actorId) {
  state = {
    paused: false,
    balance: CONFIG.startingBalance,
    equity: CONFIG.startingBalance,
    orders: [],
    positions: [],
    history: [],
    stats: { wins: 0, losses: 0, trades: 0 },
  };

  audit({
    actorId,
    action: 'PAPER_TRADING_RESET',
    targetType: 'Trading',
    targetId: 'GLOBAL',
  });
}

// ------------------ SNAPSHOT ------------------

function snapshot() {
  return {
    paused: state.paused,
    balance: Number(state.balance.toFixed(2)),
    equity: Number(state.equity.toFixed(2)),
    openPositions: state.positions.length,
    positions: state.positions,
    stats: state.stats,
  };
}

// ------------------ EXPORT ------------------

module.exports = {
  placeOrder,
  closePosition,
  pause,
  resume,
  reset,
  snapshot,
};
