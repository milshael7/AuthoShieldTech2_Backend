// backend/src/services/paperTrader.js
let state = {
  running: false,
  balance: Number(process.env.PAPER_START_BALANCE || 100000),
  pnl: 0,
  trades: [],
  position: null,
  lastPrice: null,
};

function start() {
  state.running = true;
  state.balance = Number(process.env.PAPER_START_BALANCE || state.balance || 100000);
}

function tick(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return;
  state.lastPrice = p;
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades,
    position: state.position,
    lastPrice: state.lastPrice,
  };
}

module.exports = { start, tick, snapshot };
