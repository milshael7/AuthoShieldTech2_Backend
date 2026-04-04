// ==========================================================
// 🔒 STEALTH CORE — v53 (SMART EXECUTION & BRAIN SYNC)
// Replacement for: backend/src/services/paperTrader.js
// ==========================================================

const { makeDecision } = require("./tradeBrain");

/* ================= CONFIG ================= */
const START_BAL = Number(process.env.STARTING_CAPITAL || 100000);
const HARD_STOP_LOSS = -0.0045; // -0.45%
const SLIPPAGE_BPS = 0.0002;    // 0.02% Real-world friction
const MAX_HISTORY = 300;       // Leaner for Render Stability (v53 optimization)

/* ================= STATE ================= */
const STATES = new Map();

function load(id) {
  if (!STATES.has(id)) {
    STATES.set(id, {
      balance: START_BAL,
      equity: START_BAL,
      position: null,
      history: [],
      intelligence: [], // Renamed from 'decisions'
      stats: { ticks: 0, signals: 0, executionCount: 0 }
    });
  }
  return STATES.get(id);
}

/* ================= UNIVERSAL EXECUTION ================= */

function executeExit(state, symbol, price, reason) {
  const pos = state.position;
  if (!pos) return;

  // Real-world slippage calculation
  const exitPrice = pos.side === "LONG" 
    ? price * (1 - SLIPPAGE_BPS) 
    : price * (1 + SLIPPAGE_BPS);

  const pnl = pos.side === "LONG"
      ? (exitPrice - pos.entry) * pos.qty
      : (pos.entry - exitPrice) * pos.qty;

  const record = {
    type: "EXIT",
    side: pos.side,
    entry: pos.entry,
    exit: exitPrice,
    pnl,
    reason,
    timestamp: Date.now()
  };

  state.balance += pnl;
  state.position = null;
  state.history.push(record);
  
  if (state.history.length > MAX_HISTORY) state.history.shift();
  state.stats.executionCount += 1;
  
  console.log(`[CORE]: Trade Closed | Reason: ${reason} | PnL: ${pnl.toFixed(2)}`);
}

function executeEntry(state, symbol, action, price) {
  if (state.position) return;

  const entryPrice = action === "BUY" 
    ? price * (1 + SLIPPAGE_BPS) 
    : price * (1 - SLIPPAGE_BPS);

  // Risk Management: Use 2% of capital per trade for sustainability
  const riskAmount = state.balance * 0.02; 
  const qty = riskAmount / entryPrice;

  state.position = {
    symbol,
    side: action === "BUY" ? "LONG" : "SHORT",
    entry: entryPrice,
    qty,
    stopLoss: action === "BUY" ? entryPrice * 0.995 : entryPrice * 1.005,
    takeProfit: action === "BUY" ? entryPrice * 1.01 : entryPrice * 0.99
  };

  console.log(`[CORE]: ${action} Executed at ${entryPrice.toFixed(2)}`);
}

/* ================= TICK & SYNC ================= */

function tick(id, symbol, price) {
  const state = load(id);
  state.stats.ticks += 1;

  /* --- REAL-TIME EQUITY SYNC --- */
  let currentUnrealized = 0;
  if (state.position) {
    const pos = state.position;
    currentUnrealized = pos.side === "LONG"
      ? (price - pos.entry) * pos.qty
      : (pos.entry - price) * pos.qty;
    
    // Automatic Stop/Profit Guards
    const pnlPct = currentUnrealized / (pos.entry * pos.qty);
    if (pnlPct <= HARD_STOP_LOSS) return executeExit(state, symbol, price, "HARD_STOP");
    
    if (pos.side === "LONG" && price <= pos.stopLoss) return executeExit(state, symbol, price, "STOP_LOSS");
    if (pos.side === "SHORT" && price >= pos.stopLoss) return executeExit(state, symbol, price, "STOP_LOSS");
  }
  
  state.equity = state.balance + currentUnrealized;

  /* --- INTELLIGENCE (BRAIN) CALL --- */
  const brainOutput = makeDecision({ symbol, last: price, core: state });
  
  // Sync confidence to Global for the Status Page (v32.5 server link)
  global.lastConfidence = brainOutput.confidence || 0;

  state.stats.signals += 1;
  state.intelligence.push({ ...brainOutput, ts: Date.now() });
  if (state.intelligence.length > MAX_HISTORY) state.intelligence.shift();

  /* --- STEALTH EXECUTION LOGIC --- */
  if (!state.position && brainOutput.confidence > 25) {
    if (brainOutput.action === "BUY" || brainOutput.action === "SELL") {
      executeEntry(state, symbol, brainOutput.action, price);
    }
  }

  if (state.position && brainOutput.action === "CLOSE") {
    executeExit(state, symbol, price, "AI_SIGNAL");
  }
}

function snapshot(id) {
  const s = load(id);
  return {
    equity: s.equity,
    balance: s.balance,
    position: s.position,
    history: s.history,
    intelligence: s.intelligence,
    stats: s.stats
  };
}

module.exports = { tick, snapshot };
